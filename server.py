#!/usr/bin/env python3
"""
KNTQ / HYPE local LP console.

A deliberately small, dependency-free local web server:

  * serves the static UI from ./public
  * proxies read-only JSON-RPC through a failover pool
  * caches the HYPE/USD market price and exposes freshness metadata
  * never accepts private keys and never broadcasts signed transactions

The browser wallet is the only signer.  All writes are simulated by the
frontend through eth_call/eth_estimateGas before the wallet is asked to sign.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import parse_qs, urlparse

APP_ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = APP_ROOT / "config.json"
PUBLIC_ROOT = APP_ROOT / "public"
LOG_DIR = APP_ROOT / "logs"

ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
HEX_RE = re.compile(r"^0x[0-9a-fA-F]*$")
READ_METHODS = {
    "eth_chainId",
    "eth_blockNumber",
    "eth_getBalance",
    "eth_getCode",
    "eth_getStorageAt",
    "eth_getTransactionCount",
    "eth_call",
    "eth_estimateGas",
    "eth_gasPrice",
    "eth_maxPriorityFeePerGas",
    "eth_feeHistory",
    "eth_getBlockByNumber",
    "eth_getBlockByHash",
    "eth_getLogs",
    "eth_getTransactionByHash",
    "eth_getTransactionReceipt",
    "net_version",
    "web3_clientVersion",
}
BLOCKED_METHOD_PREFIXES = ("admin_", "personal_", "miner_", "debug_", "txpool_")
MAX_BODY_BYTES = 512 * 1024
CLAIMS_FILE = Path(os.environ.get("CLAIMS_FILE", str(Path.home() / ".elysium-lp-claims.json")))
CLAIMS_LOCK = threading.Lock()


def _load_claims() -> dict[str, Any]:
    try:
        with CLAIMS_FILE.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _save_claims(claims: dict[str, Any]) -> None:
    CLAIMS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CLAIMS_FILE.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(claims, handle, ensure_ascii=False, separators=(",", ":"))
    os.chmod(tmp, 0o600)
    tmp.replace(CLAIMS_FILE)


def _owner_claims(owner: str) -> dict[str, Any]:
    with CLAIMS_LOCK:
        return _load_claims().get(owner.lower(), {})


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_config(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        config = json.load(handle)
    validate_config(config)
    return config


def validate_config(config: dict[str, Any]) -> None:
    required = [
        ("network", "chainId"),
        ("network", "name"),
        ("tokens", "KNTQ", "address"),
        ("tokens", "WHYPE", "address"),
        ("uniswap", "poolManager"),
        ("uniswap", "stateView"),
        ("uniswap", "positionManager"),
        ("uniswap", "permit2"),
        ("uniswap", "poolId"),
        ("uniswap", "fee"),
        ("uniswap", "tickSpacing"),
        ("uniswap", "poolKey", "currency1"),
        ("uniswap", "deploymentBlock"),
    ]
    for parts in required:
        node: Any = config
        for part in parts:
            if not isinstance(node, dict) or part not in node:
                raise ValueError("config missing: " + ".".join(parts))
            node = node[part]
    for key in ("poolManager", "stateView", "positionManager", "permit2"):
        if not ADDRESS_RE.match(config["uniswap"][key]):
            raise ValueError(f"invalid address: uniswap.{key}")
    pool_id = config["uniswap"]["poolId"]
    if not isinstance(pool_id, str) or not re.match(r"^0x[0-9a-fA-F]{64}$", pool_id):
        raise ValueError("invalid uniswap.poolId")
    for key in ("currency0", "currency1", "hooks"):
        if not ADDRESS_RE.match(config["uniswap"]["poolKey"][key]):
            raise ValueError(f"invalid address: uniswap.poolKey.{key}")
    for symbol in ("KNTQ", "WHYPE"):
        if not ADDRESS_RE.match(config["tokens"][symbol]["address"]):
            raise ValueError(f"invalid address: tokens.{symbol}.address")
    if int(config["network"]["chainId"]) <= 0:
        raise ValueError("invalid chainId")
    rpc_urls = config["network"].get("rpcUrls") or []
    if not isinstance(rpc_urls, list) or not rpc_urls:
        raise ValueError("network.rpcUrls must contain at least one endpoint")
    for endpoint in rpc_urls:
        if not isinstance(endpoint, dict) or not endpoint.get("url"):
            raise ValueError("each RPC endpoint needs a name and url")
    if not (0 < int(config["safety"].get("staleQuoteSeconds", 45)) <= 600):
        raise ValueError("safety.staleQuoteSeconds out of range")
    if not (0 < int(config["safety"].get("maxSlippageBps", 300)) <= 1000):
        raise ValueError("safety.maxSlippageBps out of range")


@dataclass
class RpcEndpoint:
    name: str
    url: str
    successes: int = 0
    failures: int = 0
    latency_ms: int | None = None
    last_error: str | None = None
    last_checked: float | None = None
    down_until: float = 0.0

    def healthy(self, now: float, cooldown: float) -> bool:
        return now >= self.down_until

    def public(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "url": self.url,
            "successes": self.successes,
            "failures": self.failures,
            "latencyMs": self.latency_ms,
            "lastError": self.last_error,
            "lastChecked": self.last_checked,
            "cooldown": self.down_until > time.time(),
        }


class RpcPool:
    """Health-aware read-only JSON-RPC failover pool."""

    def __init__(
        self,
        endpoints: Iterable[dict[str, Any]],
        *,
        timeout: float = 8.0,
        cooldown: float = 12.0,
        logger: logging.Logger | None = None,
    ) -> None:
        self.endpoints = [
            RpcEndpoint(str(item.get("name") or f"rpc-{i + 1}"), str(item["url"]))
            for i, item in enumerate(endpoints)
        ]
        if not self.endpoints:
            raise ValueError("no RPC endpoints")
        self.timeout = timeout
        self.cooldown = cooldown
        self.log = logger or logging.getLogger(__name__)
        self._active = 0
        self._lock = threading.Lock()

    @property
    def active(self) -> RpcEndpoint:
        return self.endpoints[self._active]

    def _post_json(self, url: str, payload: dict[str, Any] | list[Any]) -> Any:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "kntq-lp-local/1.0",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            raw = response.read(4 * 1024 * 1024)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("RPC returned invalid JSON") from exc

    @staticmethod
    def _valid_response(payload: dict[str, Any] | list[Any], response: Any) -> bool:
        if isinstance(payload, list):
            return isinstance(response, list) and len(response) == len(payload)
        return isinstance(response, dict) and ("result" in response or "error" in response)

    def request(
        self,
        payload: dict[str, Any] | list[Any],
        *,
        retries: int | None = None,
    ) -> tuple[Any, RpcEndpoint]:
        if not isinstance(payload, (dict, list)):
            raise ValueError("JSON-RPC payload must be an object or array")
        total = len(self.endpoints)
        attempts = retries if retries is not None else total
        last_error: Exception | None = None
        start_index = self._active
        now = time.time()

        order = list(range(total))
        # Prefer the currently healthy active endpoint, then the rest.
        order.sort(key=lambda idx: (idx != start_index, not self.endpoints[idx].healthy(now, self.cooldown)))

        for endpoint_index in order[: max(1, attempts)]:
            endpoint = self.endpoints[endpoint_index]
            started = time.perf_counter()
            try:
                response = self._post_json(endpoint.url, payload)
                if not self._valid_response(payload, response):
                    raise ValueError("RPC returned an unexpected response shape")
                elapsed = int((time.perf_counter() - started) * 1000)
                with self._lock:
                    endpoint.successes += 1
                    endpoint.failures = 0
                    endpoint.latency_ms = elapsed
                    endpoint.last_error = None
                    endpoint.last_checked = time.time()
                    endpoint.down_until = 0.0
                    self._active = endpoint_index
                return response, endpoint
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, ValueError) as exc:
                elapsed = int((time.perf_counter() - started) * 1000)
                last_error = exc
                with self._lock:
                    endpoint.failures += 1
                    endpoint.latency_ms = elapsed
                    endpoint.last_error = str(exc)[:240]
                    endpoint.last_checked = time.time()
                    endpoint.down_until = time.time() + self.cooldown
                self.log.warning("RPC endpoint failed name=%s error=%s", endpoint.name, str(exc)[:240])

        assert last_error is not None
        raise RpcUnavailable(str(last_error)) from last_error

    def call(
        self,
        method: str,
        params: list[Any] | None = None,
        *,
        block: str = "latest",
    ) -> Any:
        payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}
        response, _ = self.request(payload)
        if "error" in response:
            raise RpcError(response["error"], method)
        return response.get("result")

    def eth_call(self, to: str, data: str, *, sender: str | None = None, block: str = "latest") -> str:
        tx: dict[str, Any] = {"to": to, "data": data}
        if sender:
            tx["from"] = sender
        result = self.call("eth_call", [tx, block])
        if not isinstance(result, str) or not HEX_RE.match(result):
            raise RpcError({"message": "invalid eth_call result"}, "eth_call")
        return result

    def status(self) -> dict[str, Any]:
        now = time.time()
        active = self.active
        return {
            "active": active.name,
            "activeUrl": active.url,
            "endpoints": [endpoint.public() for endpoint in self.endpoints],
            "cooldownSeconds": self.cooldown,
            "now": now,
        }


class RpcError(RuntimeError):
    def __init__(self, error: dict[str, Any], method: str) -> None:
        self.code = error.get("code")
        self.data = error.get("data")
        super().__init__(f"{method}: {error.get('message', 'RPC error')}")


class RpcUnavailable(RuntimeError):
    pass


class MarketCache:
    """Small cache around Hyperliquid's public allMids endpoint."""

    def __init__(
        self,
        *,
        url: str,
        symbol: str = "HYPE",
        ttl: float = 10.0,
        stale_after: float = 90.0,
        logger: logging.Logger | None = None,
    ) -> None:
        self.url = url
        self.symbol = symbol
        self.ttl = ttl
        self.stale_after = stale_after
        self.log = logger or logging.getLogger(__name__)
        self._lock = threading.Lock()
        self._price: float | None = None
        self._fetched_at: float | None = None
        self._last_error: str | None = None
        self._source = "Hyperliquid allMids"
        self._history: dict[int, float] = {}
        self._history_lock = threading.Lock()

    def _fetch(self) -> tuple[float, float]:
        body = json.dumps({"type": "allMids"}).encode("utf-8")
        request = urllib.request.Request(
            self.url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "kntq-lp-local/1.0",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=5.0) as response:
            payload = json.loads(response.read(2 * 1024 * 1024).decode("utf-8"))
        value = payload.get(self.symbol) if isinstance(payload, dict) else None
        price = float(value) if value is not None else None
        if price is None or not (0 < price < 1_000_000):
            raise ValueError(f"{self.symbol} price missing from allMids")
        return price, time.time()


    def price_at(self, timestamp: int) -> float | None:
        """Historical HYPE close from Hyperliquid 1h candles, cached by hour."""
        hour = int(timestamp // 3600) * 3600
        with self._history_lock:
            if hour in self._history:
                return self._history[hour]
        body = json.dumps({
            "type": "candleSnapshot",
            "req": {
                "coin": self.symbol,
                "interval": "1h",
                "startTime": (hour - 3600) * 1000,
                "endTime": (hour + 7200) * 1000,
            },
        }).encode("utf-8")
        request = urllib.request.Request(
            self.url,
            data=body,
            headers={"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "elysium-lp/1.0"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=8.0) as response:
                payload = json.loads(response.read(2 * 1024 * 1024).decode("utf-8"))
            if not isinstance(payload, list) or not payload:
                return None
            target = hour * 1000
            best = None
            for candle in payload:
                try:
                    start = int(candle["t"])
                    close = float(candle["c"])
                except (KeyError, TypeError, ValueError):
                    continue
                if start <= target <= int(candle.get("T", start + 3599999)):
                    best = close
                    break
                if best is None or abs(start - target) < abs(int(best[0]) - target):
                    best = (start, close)
            price = best[1] if isinstance(best, tuple) else best
            if price is None or not (0 < price < 1_000_000):
                return None
            with self._history_lock:
                self._history[hour] = float(price)
            return float(price)
        except Exception as exc:
            self.log.warning("historical HYPE price failed: %s", str(exc)[:200])
            return None

    def get(self, *, force: bool = False) -> dict[str, Any]:
        with self._lock:
            now = time.time()
            fresh = self._fetched_at is not None and (now - self._fetched_at) < self.ttl
            if fresh and not force:
                return self._snapshot(now)
            try:
                price, fetched_at = self._fetch()
                self._price = price
                self._fetched_at = fetched_at
                self._last_error = None
            except Exception as exc:  # network/API failure must not crash reads
                self._last_error = str(exc)[:240]
                self.log.warning("market price refresh failed: %s", self._last_error)
            return self._snapshot(time.time())

    def _snapshot(self, now: float) -> dict[str, Any]:
        age = None if self._fetched_at is None else max(0.0, now - self._fetched_at)
        return {
            "symbol": self.symbol,
            "price": self._price,
            "source": self._source,
            "fetchedAt": None if self._fetched_at is None else datetime.fromtimestamp(self._fetched_at, timezone.utc).isoformat(timespec="seconds"),
            "ageSec": age,
            "stale": age is None or age > self.stale_after,
            "staleAfterSec": self.stale_after,
            "error": self._last_error,
        }


@dataclass
class AppState:
    config: dict[str, Any]
    rpc: RpcPool
    market: MarketCache
    logger: logging.Logger
    started_at: float = field(default_factory=time.time)
    _head_lock: threading.Lock = field(default_factory=threading.Lock)
    _head_cache: tuple[float, dict[str, Any]] | None = None

    def chain_head(self, *, force: bool = False) -> dict[str, Any]:
        with self._head_lock:
            now = time.time()
            if self._head_cache is not None and not force:
                cached_at, cached = self._head_cache
                if now - cached_at < 2.5:
                    return cached
            try:
                block_hex = self.rpc.call("eth_blockNumber")
                block_number = int(block_hex, 16)
                block = self.rpc.call("eth_getBlockByNumber", [hex(block_number), False])
                timestamp = int(block.get("timestamp", "0x0"), 16) if block else 0
                result = {
                    "ok": True,
                    "blockNumber": block_number,
                    "timestamp": timestamp,
                    "ageSec": max(0.0, now - timestamp) if timestamp else None,
                    "rpc": self.rpc.active.name,
                    "fetchedAt": utc_now_iso(),
                }
            except Exception as exc:
                result = {
                    "ok": False,
                    "blockNumber": None,
                    "timestamp": None,
                    "ageSec": None,
                    "rpc": self.rpc.active.name,
                    "error": str(exc)[:240],
                    "fetchedAt": utc_now_iso(),
                }
            self._head_cache = (now, result)
            return result


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], state: AppState) -> None:
        super().__init__(address, LocalHandler)
        self.state = state

    def handle_error(self, request: Any, client_address: Any) -> None:
        # Browsers close keep-alive sockets during navigation; that is normal
        # and must not spill a traceback into the console.
        if isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


class LocalHandler(BaseHTTPRequestHandler):
    server: LocalServer
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        self.server.state.logger.debug("%s - %s", self.address_string(), fmt % args)

    def _send_json(self, payload: Any, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path) -> None:
        if not path.is_file():
            self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            return
        content_type = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".ico": "image/x-icon",
        }.get(path.suffix.lower(), "application/octet-stream")
        body = path.read_bytes()
        suffix = path.suffix.lower()
        if suffix == ".html":
            cache = "no-cache"
        elif "vendor" in path.parts:
            cache = "public, max-age=31536000, immutable"
        elif suffix == ".js":
            cache = "no-cache"
        elif suffix == ".css":
            cache = "no-cache"
        elif suffix in (".png", ".svg", ".ico"):
            cache = "public, max-age=604800"
        else:
            cache = "no-cache"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> bytes | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json({"error": "invalid content-length"}, HTTPStatus.BAD_REQUEST)
            return None
        if length < 0 or length > MAX_BODY_BYTES:
            self._send_json({"error": "request body too large"}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return None
        return self.rfile.read(length) if length else b""

    @staticmethod
    def _normalized_path(raw_path: str) -> str:
        path = raw_path.split("?", 1)[0]
        if path == "/elysium-lp":
            return "/"
        if path.startswith("/elysium-lp/"):
            return path[len("/elysium-lp"):]
        return path

    def do_GET(self) -> None:  # noqa: N802
        path = self._normalized_path(self.path)
        if path == "/api/claims":
            query = parse_qs(urlparse(self.path).query)
            owner = (query.get("owner") or [""])[0].strip()
            if not ADDRESS_RE.match(owner):
                self._send_json({"error": "valid owner required"}, HTTPStatus.BAD_REQUEST)
                return
            self._send_json({"owner": owner.lower(), "claims": _owner_claims(owner)})
            return
        if path == "/api/config":
            self._send_json(public_config(self.server.state.config))
            return
        if path == "/api/status":
            self._send_json(self._status_payload())
            return
        if path == "/api/market":
            self._send_json(self.server.state.market.get())
            return
        if path == "/api/hype-history":
            query = parse_qs(urlparse(self.path).query)
            try:
                timestamp = int((query.get("ts") or ["0"])[0])
            except ValueError:
                timestamp = 0
            if timestamp <= 0:
                self._send_json({"error": "ts required"}, HTTPStatus.BAD_REQUEST)
                return
            price = self.server.state.market.price_at(timestamp)
            self._send_json({"ts": timestamp, "price": price, "source": "Hyperliquid 1h candle"})
            return
        if path == "/api/health":
            self._send_json({"ok": True, "startedAt": self.server.state.started_at})
            return
        if path in ("/favicon.ico",):
            self._send_file(PUBLIC_ROOT / "favicon.svg")
            return
        self._serve_static(path)

    def do_POST(self) -> None:  # noqa: N802
        path = self._normalized_path(self.path)
        if path == "/api/rpc":
            self._handle_rpc()
            return
        if path == "/api/claim":
            self._handle_claim()
            return
        if path == "/api/claim/clear":
            self._handle_claim_clear()
            return
        if path == "/api/market/refresh":
            self._send_json(self.server.state.market.get(force=True))
            return
        self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def _handle_claim(self) -> None:
        raw = self._read_body()
        if raw is None:
            return
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            self._send_json({"error": "invalid json"}, HTTPStatus.BAD_REQUEST)
            return
        try:
            owner = str(payload.get("owner", "")).lower()
            token_id = str(payload.get("tokenId", "")).strip()
            amount0 = float(payload.get("amount0") or 0)
            amount1 = float(payload.get("amount1") or 0)
            usd = float(payload.get("usd") or 0)
            tx_hash = str(payload.get("txHash") or "")
            if not ADDRESS_RE.match(owner) or not token_id.isdigit() or len(token_id) > 78:
                raise ValueError("owner or tokenId invalid")
            if not all(map(lambda n: 0 <= n < 1e15, (amount0, amount1, usd))):
                raise ValueError("amounts invalid")
            if tx_hash and not re.match(r"^0x[0-9a-fA-F]{64}$", tx_hash):
                raise ValueError("txHash invalid")
        except (TypeError, ValueError) as error:
            self._send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        with CLAIMS_LOCK:
            claims = _load_claims()
            owner_map = claims.setdefault(owner, {})
            entry = owner_map.get(token_id) or {"amount0": 0.0, "amount1": 0.0, "usd": 0.0, "count": 0}
            entry["amount0"] = round(float(entry.get("amount0") or 0) + amount0, 18)
            entry["amount1"] = round(float(entry.get("amount1") or 0) + amount1, 18)
            entry["usd"] = round(float(entry.get("usd") or 0) + usd, 8)
            entry["count"] = int(entry.get("count") or 0) + 1
            entry["at"] = utc_now_iso()
            if tx_hash:
                entry["txHash"] = tx_hash
            owner_map[token_id] = entry
            try:
                _save_claims(claims)
            except OSError as error:
                self._send_json({"error": "claims store unavailable", "detail": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
                return
        self._send_json({"ok": True, "owner": owner, "tokenId": token_id, "claim": entry})

    def _handle_claim_clear(self) -> None:
        raw = self._read_body()
        if raw is None:
            return
        try:
            payload = json.loads(raw)
            owner = str(payload.get("owner", "")).lower()
            token_id = str(payload.get("tokenId", "")).strip()
            if not ADDRESS_RE.match(owner) or not token_id.isdigit():
                raise ValueError("owner or tokenId invalid")
        except (json.JSONDecodeError, TypeError, ValueError) as error:
            self._send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        with CLAIMS_LOCK:
            claims = _load_claims()
            owner_map = claims.get(owner, {})
            owner_map.pop(token_id, None)
            if owner_map:
                claims[owner] = owner_map
            else:
                claims.pop(owner, None)
            try:
                _save_claims(claims)
            except OSError as error:
                self._send_json({"error": "claims store unavailable", "detail": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
                return
        self._send_json({"ok": True, "owner": owner, "tokenId": token_id})

    def _serve_static(self, path: str) -> None:
        if path in ("", "/"):
            candidate = PUBLIC_ROOT / "index.html"
        else:
            # Resolve and verify containment to prevent path traversal.
            relative = path.lstrip("/")
            candidate = (PUBLIC_ROOT / relative).resolve()
            try:
                candidate.relative_to(PUBLIC_ROOT.resolve())
            except ValueError:
                self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
                return
        self._send_file(candidate)

    def _handle_rpc(self) -> None:
        raw = self._read_body()
        if raw is None:
            return
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}, HTTPStatus.BAD_REQUEST)
            return
        problem = validate_rpc_payload(payload)
        if problem:
            self._send_json({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": problem}}, HTTPStatus.BAD_REQUEST)
            return
        try:
            response, endpoint = self.server.state.rpc.request(payload)
        except RpcUnavailable as exc:
            self._send_json(
                {"jsonrpc": "2.0", "id": None, "error": {"code": -32000, "message": f"all RPC endpoints failed: {exc}"}},
                HTTPStatus.BAD_GATEWAY,
            )
            return
        self.send_response(HTTPStatus.OK)
        body = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-RPC-Endpoint", endpoint.name)
        self.end_headers()
        self.wfile.write(body)

    def _status_payload(self) -> dict[str, Any]:
        state = self.server.state
        head = state.chain_head()
        try:
            chain_id = int(state.rpc.call("eth_chainId"), 16)
        except Exception:
            chain_id = None
        expected = int(state.config["network"]["chainId"])
        stale_after = int(state.config["safety"].get("staleQuoteSeconds", 45))
        head_age = head.get("ageSec")
        return {
            "ok": bool(head.get("ok")) and chain_id == expected,
            "expectedChainId": expected,
            "chainId": chain_id,
            "network": state.config["network"]["name"],
            "head": head,
            "stale": head_age is None or head_age > stale_after,
            "staleQuoteSeconds": stale_after,
            "rpc": state.rpc.status(),
            "market": state.market.get(),
            "serverTime": utc_now_iso(),
        }


def public_config(config: dict[str, Any]) -> dict[str, Any]:
    """Strip anything that should not reach the browser (currently nothing secret)."""
    return {
        "appName": config.get("appName"),
        "network": config["network"],
        "tokens": config["tokens"],
        "uniswap": config["uniswap"],
        "market": config.get("market", {}),
        "safety": config.get("safety", {}),
        "ui": config.get("ui", {}),
    }


def validate_rpc_payload(payload: Any) -> str | None:
    if isinstance(payload, list):
        if not payload:
            return "empty batch"
        if len(payload) > 50:
            return "batch too large (max 50)"
        for item in payload:
            problem = validate_rpc_payload(item)
            if problem:
                return problem
        return None
    if not isinstance(payload, dict):
        return "request must be an object or array"
    method = payload.get("method")
    if not isinstance(method, str) or not method:
        return "missing method"
    if method.startswith(BLOCKED_METHOD_PREFIXES) or method in {"eth_sendTransaction", "eth_sendRawTransaction", "eth_sign", "eth_signTransaction"}:
        return "write methods are not accepted by the read-only RPC proxy"
    if method not in READ_METHODS:
        return f"method not allowed: {method}"
    params = payload.get("params", [])
    if not isinstance(params, (list, dict)):
        return "invalid params"
    return None


def setup_logging(verbose: bool = False) -> logging.Logger:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("kntq_lp")
    logger.setLevel(logging.DEBUG if verbose else logging.INFO)
    logger.handlers.clear()
    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%H:%M:%S"))
    logger.addHandler(stream)
    file_handler = logging.FileHandler(LOG_DIR / "server.log", encoding="utf-8")
    file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(file_handler)
    return logger


def find_free_port(host: str, preferred: int) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, preferred))
            return preferred
        except OSError:
            sock.bind((host, 0))
            return int(sock.getsockname()[1])


def main() -> int:
    parser = argparse.ArgumentParser(description="Local KNTQ/HYPE Uniswap V3 LP console")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--no-open", action="store_true", help="do not open a browser")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logger = setup_logging(args.verbose)
    try:
        config = load_config(args.config)
    except Exception as exc:
        logger.error("failed to load config: %s", exc)
        return 2

    rpc = RpcPool(config["network"]["rpcUrls"], timeout=20.0, cooldown=5.0, logger=logger)
    market = MarketCache(
        url=config.get("market", {}).get("hypeUsdUrl", "https://api.hyperliquid.xyz/info"),
        symbol="HYPE",
        ttl=float(config.get("market", {}).get("refreshSeconds", 10)),
        stale_after=float(config.get("market", {}).get("staleSeconds", 90)),
        logger=logger,
    )
    state = AppState(config=config, rpc=rpc, market=market, logger=logger)

    port = find_free_port(args.host, args.port)
    if port != args.port:
        logger.warning("port %s is busy, using %s instead", args.port, port)
    server = LocalServer((args.host, port), state)
    url = f"http://{args.host}:{port}"
    logger.info("KNTQ/HYPE LP console: %s", url)
    logger.info("read-only RPC failover: %s", ", ".join(endpoint.name for endpoint in rpc.endpoints))
    if not args.no_open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("shutting down")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
