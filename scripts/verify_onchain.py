#!/usr/bin/env python3
"""Read-only verification of the Elysium KNTQ/HYPE Uniswap V4 pool."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402

SEL_SLOT0 = "0xc815641c"
SEL_LIQUIDITY = "0xfa6793d5"
SEL_POOL_MANAGER = "0xdc4c90d3"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=ROOT / "config.json")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    report = {"ok": False, "checks": {}}
    try:
        config = server.load_config(args.config)
        rpc = server.RpcPool(config["network"]["rpcUrls"], timeout=15, cooldown=0)
        chain_id = int(rpc.call("eth_chainId"), 16)
        block = int(rpc.call("eth_blockNumber"), 16)
        report.update({
            "network": config["network"]["name"],
            "chainId": chain_id,
            "expectedChainId": config["network"]["chainId"],
            "blockNumber": block,
            "rpc": rpc.active.name,
        })
        if chain_id != int(config["network"]["chainId"]):
            raise RuntimeError(f"chainId mismatch: {chain_id}")
        addresses = {
            "poolManager": config["uniswap"]["poolManager"],
            "stateView": config["uniswap"]["stateView"],
            "positionManager": config["uniswap"]["positionManager"],
            "permit2": config["uniswap"]["permit2"],
            "KNTQ": config["tokens"]["KNTQ"]["address"],
        }
        for name, address in addresses.items():
            code = rpc.call("eth_getCode", [address, "latest"])
            size = max(0, (len(code) - 2) // 2) if code else 0
            report["checks"][name] = {"address": address, "codeBytes": size}
            if size == 0:
                raise RuntimeError(f"{name} has no code")

        pool_id = config["uniswap"]["poolId"]
        slot0_raw = rpc.eth_call(config["uniswap"]["stateView"], SEL_SLOT0 + pool_id[2:])
        words = [slot0_raw[2:][i : i + 64] for i in range(0, len(slot0_raw[2:]), 64)]
        sqrt_price = int(words[0], 16)
        tick = int(words[1], 16)
        if tick >= 1 << 23:
            tick -= 1 << 24
        lp_fee = int(words[3], 16)
        liquidity_raw = rpc.eth_call(config["uniswap"]["stateView"], SEL_LIQUIDITY + pool_id[2:])
        liquidity = int(liquidity_raw, 16)
        manager_raw = rpc.eth_call(config["uniswap"]["stateView"], SEL_POOL_MANAGER)
        manager = "0x" + manager_raw[-40:]
        report["pool"] = {
            "poolId": pool_id,
            "tick": tick,
            "sqrtPriceX96": str(sqrt_price),
            "lpFee": lp_fee,
            "liquidity": str(liquidity),
            "poolManager": manager,
            "rawPriceKntqPerHype": (sqrt_price / (1 << 96)) ** 2,
        }
        if lp_fee != int(config["uniswap"]["fee"]):
            raise RuntimeError("LP fee mismatch")
        if manager.lower() != config["uniswap"]["poolManager"].lower():
            raise RuntimeError("StateView poolManager mismatch")
        if liquidity <= 0:
            raise RuntimeError("pool has no liquidity")

        market = server.MarketCache(url=config["market"]["hypeUsdUrl"], ttl=0, stale_after=90)
        market_snapshot = market.get(force=True)
        report["market"] = market_snapshot
        if market_snapshot.get("price"):
            report["kntqUsd"] = market_snapshot["price"] / report["pool"]["rawPriceKntqPerHype"]
        report["ok"] = True
    except Exception as exc:
        report["error"] = str(exc)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
