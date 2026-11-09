#!/usr/bin/env node
/* Read-only Elysium LP Bark report (5-min timer). Aligns HYPE totals with dashboard updateHypeUi. No private keys. */
'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require(path.join(__dirname, '..', 'public', 'vendor', 'ethers.umd.min.js'));
const M = require(path.join(__dirname, '..', 'public', 'math.js'));

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const OWNER = (process.env.DEFAULT_ADDRESS || CONFIG.ui.defaultAddress || '').trim();
const BARK_KEY = (process.env.BARK_KEY || '').trim();
const BARK_SERVER = (process.env.BARK_SERVER || 'https://api.day.app').replace(/\/+$/, '');
const CACHE_FILE = process.env.ENTRY_CACHE || path.join(process.env.HOME || '/tmp', '.elysium-lp-entry-cache.json');
const CLAIMS_FILE = process.env.CLAIMS_FILE || path.join(process.env.HOME || '/tmp', '.elysium-lp-claims.json');
const ACTIVE_FILE = process.env.ACTIVE_IDS_FILE || path.join(process.env.HOME || '/tmp', '.elysium-lp-active-ids.json');
const REFERENCE_FILE = process.env.REFERENCE_FILE || path.join(process.env.HOME || '/tmp', '.elysium-lp-reference.json');
const ALERTS_FILE = process.env.ALERTS_FILE || path.join(process.env.HOME || '/tmp', '.elysium-lp-alerts.json');
const DRY_RUN = String(process.env.DRY_RUN || '').trim() === '1';
const APR_ALERT_THRESHOLD = Number(process.env.APR_ALERT_THRESHOLD || 20000);
const ALERT_COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MINUTES || 30) * 60 * 1000;

const ABI = {
  erc20: [
    'function balanceOf(address) view returns (uint256)'
  ],
  pm: [
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,uint256 info)',
    'function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)'
  ],
  state: [
    'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
    'function getPositionInfo(bytes32 poolId,bytes32 positionId) view returns (uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128)',
    'function getFeeGrowthInside(bytes32 poolId,int24 tickLower,int24 tickUpper) view returns (uint256 feeGrowthInside0X128,uint256 feeGrowthInside1X128)'
  ]
};

function int24(v) {
  const n = Number(v & 0xffffffn);
  return n >= 0x800000 ? n - 0x1000000 : n;
}

function feeFromGrowth(liquidity, current, last) {
  if (liquidity <= 0n) return 0n;
  const delta = (current - last + (1n << 256n)) % (1n << 256n);
  return (liquidity * delta) >> 128n;
}

function loadClaims() {
  try { return JSON.parse(fs.readFileSync(CLAIMS_FILE, 'utf8')); } catch (_) { return {}; }
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) { return {}; }
}

function saveCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), { mode: 0o600 });
  } catch (_) { /* report can continue without cache */ }
}

function loadReference() {
  try { return JSON.parse(fs.readFileSync(REFERENCE_FILE, 'utf8')); } catch (_) { return {}; }
}

function loadAlertState() {
  try { return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')); } catch (_) { return { outOfRange: {}, aprHigh: {} }; }
}

function saveAlertState(value) {
  try {
    fs.mkdirSync(path.dirname(ALERTS_FILE), { recursive: true });
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(value), { mode: 0o600 });
  } catch (_) { /* alert state is optional */ }
}

function loadActiveState() {
  try {
    const raw = JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8'));
    const ids = Array.isArray(raw?.ids) ? raw.ids : (Array.isArray(raw) ? raw : []);
    const closed = raw && typeof raw.closed === 'object' && raw.closed ? raw.closed : {};
    return {
      ids: [...new Set(ids.map(String).filter(Boolean))],
      closed: closed
    };
  } catch (_) { return { ids: [], closed: {} }; }
}

function loadActiveIds() {
  return loadActiveState().ids;
}

function saveActiveState(ids, closed) {
  try {
    fs.mkdirSync(path.dirname(ACTIVE_FILE), { recursive: true });
    fs.writeFileSync(ACTIVE_FILE, JSON.stringify({
      updatedAt: Date.now(),
      ids: [...new Set(ids.map(String))],
      closed: closed || {}
    }), { mode: 0o600 });
  } catch (_) { /* report can continue without active cache */ }
}

function saveActiveIds(ids) {
  const prev = loadActiveState();
  saveActiveState(ids, prev.closed);
}

function isRecentlyClosed(closedMap, id) {
  const ts = Number(closedMap?.[id] || 0);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  // Skip confirmed-closed / burned ids for 7 days to spare RPC budget.
  return (Date.now() - ts) < 7 * 24 * 3600 * 1000;
}

function isBenignOwnerMiss(error) {
  const msg = String(error?.message || error || '');
  return /NOT_MINT|nonexistent|invalid token|ERC721: invalid|owner query for nonexistent/i.test(msg);
}


function fmtUsd(value, digits) {
  if (!Number.isFinite(value)) return '—';
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: digits == null ? 2 : digits, maximumFractionDigits: digits == null ? 2 : digits });
}

function fmtSignedUsd(value) {
  if (!Number.isFinite(value)) return '—';
  return (value >= 0 ? '+' : '-') + fmtUsd(Math.abs(value), 2);
}

async function fetchHypeAt(timestamp) {
  const hour = Math.floor(timestamp / 3600) * 3600;
  const response = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'candleSnapshot',
      req: { coin: 'HYPE', interval: '1h', startTime: (hour - 3600) * 1000, endTime: (hour + 7200) * 1000 }
    })
  });
  const candles = await response.json();
  if (!Array.isArray(candles) || !candles.length) return null;
  const target = hour * 1000;
  let nearest = null;
  for (const candle of candles) {
    const start = Number(candle.t);
    const close = Number(candle.c);
    if (!Number.isFinite(start) || !Number.isFinite(close)) continue;
    if (start <= target && target <= Number(candle.T || start + 3599999)) return close;
    if (nearest == null || Math.abs(start - target) < Math.abs(nearest.start - target)) nearest = { start, close };
  }
  return nearest ? nearest.close : null;
}

async function postBark(title, body) {
  if (!BARK_KEY) {
    console.log('[bark] BARK_KEY missing; skip');
    return;
  }
  const response = await fetch(BARK_SERVER + '/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_key: BARK_KEY,
      title,
      body,
      group: 'Elysium LP',
      isArchive: 1,
      level: 'active'
    })
  });
  console.log('[bark]', response.status, (await response.text()).slice(0, 180));
}

function safeError(error) {
  return String(error?.message || error || 'unknown error')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}


function barkRpcEndpoints() {
  return (Array.isArray(CONFIG.network?.rpcUrls) ? CONFIG.network.rpcUrls : [])
    .filter((ep) => ep && ep.url);
}

async function probeRpc(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload || payload.error || !payload.result) throw new Error(payload?.error?.message || 'RPC probe failed');
    if (Number(BigInt(payload.result)) !== Number(CONFIG.network.chainId)) throw new Error('RPC chainId mismatch');
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function transientRpcError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return /429|too many requests|rate limit|exceeded maximum retry|timeout|bad gateway|502|503|504|missing response|could not coalesce|missing revert data|call revert exception|could not decode result data/.test(message);
}

async function rpcRetry(fn, label, attempts = 6) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await fn(); }
    catch (error) {
      last = error;
      if (!transientRpcError(error) || attempt >= attempts - 1) throw error;
      const wait = 500 * (attempt + 1);
      console.log('[retry]', label, 'attempt', attempt + 1, 'wait', wait);
      await sleep(wait);
    }
  }
  throw last;
}

async function sendAlerts(rows) {
  if (DRY_RUN) console.log('[signals]', rows.map((row) => '#' + row.id + ' in=' + row.inRange + ' apr5m=' + (row.apr5m == null ? '—' : Math.round(row.apr5m))).join(' | '));
  const state = loadAlertState();
  state.outOfRange = state.outOfRange || {};
  state.aprHigh = state.aprHigh || {};
  const now = Date.now();
  const cooldown = ALERT_COOLDOWN_MS;
  const currentIds = new Set(rows.map((row) => String(row.id)));
  for (const key of Object.keys(state.outOfRange || {})) if (!currentIds.has(key)) delete state.outOfRange[key];
  for (const key of Object.keys(state.aprHigh || {})) if (!currentIds.has(key)) delete state.aprHigh[key];
  for (const row of rows) {
    const id = String(row.id);
    if (row.inRange === false && (!state.outOfRange[id] || now - state.outOfRange[id] > cooldown)) {
      if (DRY_RUN) {
        console.log('[alert] DRY_RUN out-of-range #' + id);
      } else {
        await postBark('⚠️ Elysium LP 出区间', `#${id} 已出区间\n距下轨 ${row.distDown == null ? '—' : row.distDown.toFixed(1)}% / 距上轨 ${row.distUp == null ? '—' : row.distUp.toFixed(1)}%\n区间 ${fmtUsd(row.lowerUsd)} – ${fmtUsd(row.upperUsd)} KNTQ/USDT\n${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
      }
      state.outOfRange[id] = now;
    }
    if (row.apr5m != null && row.apr5m > APR_ALERT_THRESHOLD && (!state.aprHigh[id] || now - state.aprHigh[id] > cooldown)) {
      if (DRY_RUN) {
        console.log('[alert] DRY_RUN 5m APR #' + id, row.apr5m.toFixed(0));
      } else {
        await postBark('🚀 Elysium LP 5m 年化超 ' + APR_ALERT_THRESHOLD + '%', `#${id} 5m 年化 ${row.apr5m.toFixed(0)}%\n本金 ${fmtUsd(row.principalUsd)} · 待领 ${fmtUsd(row.feeUsd)}\n${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
      }
      state.aprHigh[id] = now;
    }
    if (row.inRange !== false) delete state.outOfRange[id];
    if (!(row.apr5m > APR_ALERT_THRESHOLD)) delete state.aprHigh[id];
  }
  if (!DRY_RUN) saveAlertState(state);
}

async function runReport(rpcUrl) {
  await probeRpc(rpcUrl);
  const provider = new ethers.JsonRpcProvider(rpcUrl, Number(CONFIG.network.chainId), { staticNetwork: true });
  const connection = provider._getConnection?.();
  if (connection) connection.timeout = 20000;
  const pmAddress = ethers.getAddress(CONFIG.uniswap.positionManager);
  const stateAddress = ethers.getAddress(CONFIG.uniswap.stateView);
  const pm = new ethers.Contract(pmAddress, ABI.pm, provider);
  const state = new ethers.Contract(stateAddress, ABI.state, provider);
  const poolId = CONFIG.uniswap.poolId;
  const poolHigh = BigInt(poolId) >> 56n;
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const zeroTopic = '0x' + '0'.repeat(64);

  const logs = await rpcRetry(() => provider.getLogs({
    address: pmAddress,
    fromBlock: Number(CONFIG.uniswap.deploymentBlock),
    toBlock: 'latest',
    topics: [transferTopic, null, '0x' + OWNER.slice(2).toLowerCase().padStart(64, '0')]
  }), 'getLogs');
  const ids = [];
  const mintBlocks = new Map();
  for (const log of logs) {
    if (!log.topics || log.topics.length < 4) continue;
    const id = BigInt(log.topics[3]).toString();
    if (String(log.topics[1]).toLowerCase() === zeroTopic) mintBlocks.set(id, Number(log.blockNumber));
    if (!ids.includes(id)) ids.push(id);
  }
  // Merge previously-known active LPs so a flaky getLogs cannot drop a live position.
  const activeState = loadActiveState();
  const knownActive = activeState.ids;
  const closedMap = { ...activeState.closed };
  const beforeFilter = ids.length;
  const filtered = ids.filter((id) => knownActive.includes(id) || !isRecentlyClosed(closedMap, id));
  ids.length = 0;
  ids.push(...filtered);
  for (const id of knownActive) {
    if (!ids.includes(id)) ids.push(id);
  }
  console.log('[discover]', 'logs=' + logs.length, 'rawIds=' + beforeFilter, 'ids=' + ids.join(','), 'knownActive=' + (knownActive.join(',') || '-'));

  const slot0 = await rpcRetry(() => state.getSlot0(poolId), 'slot0');
  const currentSqrt = BigInt(slot0[0]);
  const rawPrice = (Number(currentSqrt) / 2 ** 96) ** 2;
  let hypeUsd = 0;
  try {
    const marketResponse = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'allMids' })
    });
    const mids = await marketResponse.json();
    hypeUsd = Number(mids.HYPE) || 0;
  } catch (_) { /* token amounts still show */ }
  const kntqUsd = hypeUsd > 0 && rawPrice > 0 ? hypeUsd / rawPrice : 0;

  const latestBlock = await rpcRetry(() => provider.getBlock('latest'), 'latestBlock');
  let oldBlock = null;
  try {
    const sample = await rpcRetry(() => provider.getBlock(Math.max(1, latestBlock.number - 10000)), 'blockSample');
    const secPerBlock = Math.max(0.02, (latestBlock.timestamp - Number(sample.timestamp)) / 10000);
    oldBlock = await rpcRetry(() => provider.getBlock(Math.max(1, latestBlock.number - Math.max(1000, Math.round(300 / secPerBlock)))), 'oldBlock');
  } catch (error) {
    console.log('[5m-apr] block window unavailable:', String(error.message || error).slice(0, 100));
  }
  const cache = loadCache();
  const rows = [];
  let failedPositions = 0;
  const claimBook = loadClaims()[OWNER.toLowerCase()] || {};
  const confirmedClosed = new Set();
  for (const id of ids) {
    try {
      let owner;
      try {
        owner = await rpcRetry(() => pm.ownerOf(id), 'ownerOf ' + id);
      } catch (error) {
        if (isBenignOwnerMiss(error)) {
          confirmedClosed.add(id);
          continue;
        }
        failedPositions += 1;
        console.log('[position]', id, 'ownerOf', String(error.message || error).slice(0, 120));
        continue;
      }
      if (owner.toLowerCase() !== OWNER.toLowerCase()) {
        confirmedClosed.add(id);
        continue;
      }
      const info = await rpcRetry(() => pm.getPoolAndPositionInfo(id), 'positionInfo ' + id);
      const packed = BigInt(info[1]);
      if ((packed >> 56n) !== poolHigh) {
        confirmedClosed.add(id);
        continue;
      }
      const lower = int24((packed >> 8n) & 0xffffffn);
      const upper = int24((packed >> 32n) & 0xffffffn);
      const liquidity = await rpcRetry(() => pm.getPositionLiquidity(id), 'liquidity ' + id);
      if (liquidity === 0n) {
        confirmedClosed.add(id);
        continue;
      }
      const key = ethers.keccak256(ethers.solidityPacked(
        ['address', 'int24', 'int24', 'bytes32'],
        [pmAddress, lower, upper, ethers.zeroPadValue(ethers.toBeHex(BigInt(id)), 32)]
      ));
      const [positionInfo, growth] = await rpcRetry(() => Promise.all([
        state.getPositionInfo(poolId, key),
        state.getFeeGrowthInside(poolId, lower, upper)
      ]), 'feeGrowth ' + id);
      const fee0 = feeFromGrowth(liquidity, growth[0], positionInfo[1]);
      const fee1 = feeFromGrowth(liquidity, growth[1], positionInfo[2]);
      const feeHype = Number(ethers.formatUnits(fee0, 18));
      const feeKntq = Number(ethers.formatUnits(fee1, 18));
      const feeUsd = hypeUsd > 0 ? feeHype * hypeUsd + feeKntq * kntqUsd : null;
      const amountsNow = M.amountsForLiquidity(liquidity, M.tickToSqrtRatioX96(lower), M.tickToSqrtRatioX96(upper), currentSqrt);
      const principalUsd = hypeUsd > 0 ? Number(ethers.formatUnits(amountsNow.amount0, 18)) * hypeUsd + Number(ethers.formatUnits(amountsNow.amount1, 18)) * kntqUsd : null;

      const mintBlock = mintBlocks.get(id);
      let entry = mintBlock ? cache[id + ':' + mintBlock] : null;
      if (!entry && mintBlock) {
        try {
          const block = await rpcRetry(() => provider.getBlock(mintBlock), 'mintBlock ' + id);
          const [slot0Mint, liquidityMint] = await rpcRetry(() => Promise.all([
            state.getSlot0(poolId, { blockTag: mintBlock }),
            pm.getPositionLiquidity(id, { blockTag: mintBlock })
          ]), 'mintState ' + id);
          const mintL = liquidityMint === 0n ? liquidity : liquidityMint;
          const mintSqrt = BigInt(slot0Mint[0]);
          const hypeAt = (await fetchHypeAt(Number(block.timestamp))) || hypeUsd;
          const amountsMint = M.amountsForLiquidity(mintL, M.tickToSqrtRatioX96(lower), M.tickToSqrtRatioX96(upper), mintSqrt);
          const mintRaw = M.priceFromSqrtX96(mintSqrt);
          const kntqAt = mintRaw > 0 ? hypeAt / mintRaw : kntqUsd;
          entry = {
            valueUsd: Number(ethers.formatUnits(amountsMint.amount0, 18)) * hypeAt + Number(ethers.formatUnits(amountsMint.amount1, 18)) * kntqAt,
            hypeAt, kntqAt, mintTs: Number(block.timestamp)
          };
          cache[id + ':' + mintBlock] = entry;
        } catch (error) {
          console.log('[entry]', id, String(error.message || error).slice(0, 120));
        }
      }
      const claim = claimBook[String(id)] || {};
      const claimedUsd = Number(claim.usd || 0);
      const currentValue = principalUsd == null ? null : principalUsd + (feeUsd || 0) + claimedUsd;
      const pnl = entry && currentValue != null ? currentValue - entry.valueUsd : null;
      const currentUsd = kntqUsd;
      const lowerUsd = 1 / M.priceFromSqrtX96(M.tickToSqrtRatioX96(upper)) * hypeUsd;
      const upperUsd = 1 / M.priceFromSqrtX96(M.tickToSqrtRatioX96(lower)) * hypeUsd;
      let apr5m = null;
      if (oldBlock && principalUsd > 0 && hypeUsd > 0 && kntqUsd > 0) {
        try {
          const oldGrowth = await rpcRetry(() => state.getFeeGrowthInside(poolId, lower, upper, { blockTag: oldBlock.number }), 'oldGrowth ' + id);
          const past0 = feeFromGrowth(liquidity, growth[0], oldGrowth[0]);
          const past1 = feeFromGrowth(liquidity, growth[1], oldGrowth[1]);
          const elapsed = Number(latestBlock.timestamp) - Number(oldBlock.timestamp);
          const pastUsd = Number(ethers.formatUnits(past0, 18)) * hypeUsd + Number(ethers.formatUnits(past1, 18)) * kntqUsd;
          if (elapsed > 60 && pastUsd >= 0) apr5m = pastUsd / principalUsd * (365 * 86400 / elapsed) * 100;
        } catch (error) {
          console.log('[5m-apr]', id, String(error.message || error).slice(0, 100));
        }
      }
      rows.push({
        id, feeHype, feeKntq, feeUsd, pnl, principalUsd, claimedUsd, apr5m,
        inRange: currentUsd > 0 && lowerUsd > 0 && upperUsd > 0 ? currentUsd >= lowerUsd && currentUsd <= upperUsd : null,
        lowerUsd, upperUsd,
        distUp: currentUsd > 0 ? (upperUsd / currentUsd - 1) * 100 : null,
        distDown: currentUsd > 0 ? (currentUsd / lowerUsd - 1) * 100 : null
      });
    } catch (error) {
      failedPositions += 1;
      console.log('[position]', id, String(error.message || error).slice(0, 120));
    }
  }
  if (failedPositions > 0) {
    console.log('[position] skipped unreadable candidates:', failedPositions, 'rows=', rows.length);
    if (!rows.length) throw new Error('position read incomplete: no readable positions');
  }
  // Guard: a previously-active LP must either appear in rows or be confirmed closed this run.
  const missingKnown = knownActive.filter((id) => !rows.some((row) => row.id === id) && !confirmedClosed.has(id));
  if (missingKnown.length) {
    throw new Error('known active LP missing from report: ' + missingKnown.join(',') + '; refusing partial report');
  }
  saveCache(cache);
  for (const id of confirmedClosed) closedMap[id] = Date.now();
  // Drop closed markers for ids that are active again.
  for (const row of rows) delete closedMap[row.id];
  saveActiveState(rows.map((row) => row.id), closedMap);
  console.log('[positions]', rows.map((row) => '#' + row.id).join(' ') || '(none)');

  const totalFees = rows.reduce((sum, row) => sum + (row.feeUsd || 0), 0);
  const totalFeeHypeAmt = rows.reduce((sum, row) => sum + row.feeHype, 0);
  const totalFeeKntqAmt = rows.reduce((sum, row) => sum + row.feeKntq, 0);
  const totalClaimed = Object.values(claimBook).reduce((sum, row) => sum + Number(row.usd || 0), 0);
  const pnlRows = rows.filter((row) => row.pnl != null);
  const totalPnl = pnlRows.length ? pnlRows.reduce((sum, row) => sum + row.pnl, 0) : null;

  // Dashboard (updateHypeUi)口径：
  //   lpHype = (Σ principalUsd + Σ feesUsd) / hypeUsd
  //   total = Elysium原生HYPE + 钱包KNTQ折合 + HyperEVM原生HYPE + lpHype
  //   含钱包 KNTQ 折合；待领费计入 LP 折合。
  const principalUsdSum = rows.reduce((sum, row) => sum + (row.principalUsd || 0), 0);
  const feeUsdSum = rows.reduce((sum, row) => sum + (row.feeUsd || 0), 0);
  const lpPrincipalHype = hypeUsd > 0 ? principalUsdSum / hypeUsd : null;
  const pendingFeesHype = hypeUsd > 0 ? feeUsdSum / hypeUsd : null;
  const lpHypeEq = (lpPrincipalHype != null && pendingFeesHype != null) ? (lpPrincipalHype + pendingFeesHype) : null;

  let elyHype = null;
  let hyperHype = null;
  let hypeComplete = false;
  let totalHypeEq = null;
  let vsRef = null;
  let vsPct = null;
  const savedRef = loadReference()[OWNER.toLowerCase()];
  const ref = Number(savedRef != null ? savedRef : (CONFIG.ui?.hypeReference || 0));
  try {
    const kntq = new ethers.Contract(CONFIG.tokens.KNTQ.address, ABI.erc20, provider);
    const [nativeHype, kntqWallet] = await rpcRetry(() => Promise.all([
      nativeBalance(OWNER),
      kntq.balanceOf(OWNER)
    ]), 'wallet balances');
    elyHype = Number(ethers.formatUnits(nativeHype, 18)) + (hypeUsd > 0 ? Number(ethers.formatUnits(kntqWallet, 18)) * kntqUsd / hypeUsd : 0);
    hyperHype = Number(ethers.formatUnits(await hyperEvmBalance(OWNER), 18));
    if (lpHypeEq != null) {
      totalHypeEq = elyHype + hyperHype + lpHypeEq;
      hypeComplete = true;
      if (ref > 0) {
        vsRef = totalHypeEq - ref;
        vsPct = (vsRef / ref) * 100;
      }
    }
  } catch (error) {
    console.log('[hype-total]', String(error.message || error).slice(0, 120));
  }

  const title = `💧 Elysium  待领 ${fmtUsd(totalFees)}`;
  const fmtH = (v, d = 3) => (v == null || !Number.isFinite(v)) ? '—' : Number(v).toFixed(d);
  const fmtSigned = (v, d = 3) => (v == null || !Number.isFinite(v)) ? '—' : ((v >= 0 ? '+' : '') + Number(v).toFixed(d));

  const lines = [];
  if (hypeComplete) {
    lines.push(`资金目前合计≈${fmtH(totalHypeEq, 3)} HYPE`);
    if (ref > 0) lines.push(`参考${fmtH(ref, 2)}：${fmtSigned(vsRef, 3)} HYPE（${fmtSigned(vsPct, 2)}%）`);
    else lines.push('参考—：—');
  } else {
    lines.push('资金目前合计不完整（Elysium/HyperEVM/LP报价）');
    lines.push('参考—：—');
  }

  lines.push('');
  lines.push(`目前LP本金 ${fmtH(lpPrincipalHype, 3)} | 待领费 ${fmtH(pendingFeesHype, 3)}`);
  lines.push(`加上手续费收益净PNL：${totalPnl == null ? '—' : fmtSignedUsd(totalPnl)}`);
  if (totalClaimed > 0) lines.push(`已领手续费 ${fmtUsd(totalClaimed)}（已计入PNL）`);

  lines.push('');
  lines.push(`目前费用收入${fmtUsd(totalFees)}`);
  lines.push(`（${totalFeeHypeAmt.toFixed(6)} HYPE + ${totalFeeKntqAmt.toFixed(4)} KNTQ）`);

  lines.push('');
  if (rows.length >= 1) {
    for (const row of rows) {
      lines.push(`#${row.id} 距上${row.distUp == null ? '—' : row.distUp.toFixed(1) + '%'} 下${row.distDown == null ? '—' : row.distDown.toFixed(1) + '%'}`);
    }
  } else {
    lines.push('暂无有效仓位');
  }

  lines.push('');
  lines.push(new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }));

  const body = lines.join('\n');
  console.log(title);
  console.log(body);
  if (DRY_RUN) {
    console.log('[bark] DRY_RUN=1; skip push');
    await sendAlerts(rows);
    return;
  }
  await postBark(title, body);
  await sendAlerts(rows);
}

async function nativeBalance(owner) {
  let lastError = null;
  // Prefer the secondary RPC for the periodic job: the official endpoint
  // rate-limits bursts, while the fallback keeps full position reads.
  const reportEndpoints = barkRpcEndpoints();
  for (const endpoint of reportEndpoints) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(endpoint.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [owner, 'latest'] }),
          signal: controller.signal
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const payload = await response.json();
        if (!payload || payload.error || typeof payload.result !== 'string') throw new Error('balance failed');
        return BigInt(payload.result);
      } finally { clearTimeout(timer); }
    } catch (error) { lastError = error; console.log('[balance]', endpoint.name, String(error.message || error).slice(0, 100)); }
  }
  throw lastError || new Error('no balance RPC');
}

async function hyperEvmBalance(owner) {
  const response = await fetch((CONFIG.ui && CONFIG.ui.hyperEvmRpc) || 'https://rpc.hyperliquid.xyz/evm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [owner, 'latest'] })
  });
  if (!response.ok) throw new Error('HyperEVM HTTP ' + response.status);
  const payload = await response.json();
  if (!payload || payload.error || typeof payload.result !== 'string') throw new Error('HyperEVM balance failed');
  return BigInt(payload.result);
}

async function main() {
  if (!OWNER.startsWith('0x') || OWNER.length !== 42) throw new Error('DEFAULT_ADDRESS invalid');
  let lastError = null;
  const reportEndpoints = barkRpcEndpoints();
  for (const endpoint of reportEndpoints) {
    try {
      console.log('[rpc]', endpoint.name);
      await runReport(endpoint.url);
      return;
    } catch (error) {
      lastError = error;
      console.error('[rpc failed]', endpoint.name, safeError(error));
    }
  }
  throw lastError || new Error('all RPC endpoints failed');
}

main().catch(async (error) => {
  const message = safeError(error);
  console.error('[report]', message);
  try { await postBark('⚠️ Elysium LP 报表失败', message); } catch (_) { /* noop */ }
  process.exitCode = 1;
});
