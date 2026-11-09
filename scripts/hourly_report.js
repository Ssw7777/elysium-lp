#!/usr/bin/env node
/* Hourly read-only Elysium LP report to Bark. No private keys. */
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

  const logs = await provider.getLogs({
    address: pmAddress,
    fromBlock: Number(CONFIG.uniswap.deploymentBlock),
    toBlock: 'latest',
    topics: [transferTopic, null, '0x' + OWNER.slice(2).toLowerCase().padStart(64, '0')]
  });
  const ids = [];
  const mintBlocks = new Map();
  for (const log of logs) {
    if (!log.topics || log.topics.length < 4) continue;
    const id = BigInt(log.topics[3]).toString();
    if (String(log.topics[1]).toLowerCase() === zeroTopic) mintBlocks.set(id, Number(log.blockNumber));
    if (!ids.includes(id)) ids.push(id);
  }

  const slot0 = await state.getSlot0(poolId);
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

  const cache = loadCache();
  const rows = [];
  let failedPositions = 0;
  const claimBook = loadClaims()[OWNER.toLowerCase()] || {};
  for (const id of ids) {
    try {
      let owner;
      try { owner = await pm.ownerOf(id); } catch (_) { continue; }
      if (owner.toLowerCase() !== OWNER.toLowerCase()) continue;
      const info = await pm.getPoolAndPositionInfo(id);
      const packed = BigInt(info[1]);
      if ((packed >> 56n) !== poolHigh) continue;
      const lower = int24((packed >> 8n) & 0xffffffn);
      const upper = int24((packed >> 32n) & 0xffffffn);
      const liquidity = await pm.getPositionLiquidity(id);
      if (liquidity === 0n) continue;
      const key = ethers.keccak256(ethers.solidityPacked(
        ['address', 'int24', 'int24', 'bytes32'],
        [pmAddress, lower, upper, ethers.zeroPadValue(ethers.toBeHex(BigInt(id)), 32)]
      ));
      const [positionInfo, growth] = await Promise.all([
        state.getPositionInfo(poolId, key),
        state.getFeeGrowthInside(poolId, lower, upper)
      ]);
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
          const block = await provider.getBlock(mintBlock);
          const [slot0Mint, liquidityMint] = await Promise.all([
            state.getSlot0(poolId, { blockTag: mintBlock }),
            pm.getPositionLiquidity(id, { blockTag: mintBlock })
          ]);
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
      rows.push({
        id, feeHype, feeKntq, feeUsd, pnl, principalUsd, claimedUsd,
        distUp: currentUsd > 0 ? (upperUsd / currentUsd - 1) * 100 : null,
        distDown: currentUsd > 0 ? (currentUsd / lowerUsd - 1) * 100 : null
      });
    } catch (error) {
      failedPositions += 1;
      console.log('[position]', id, String(error.message || error).slice(0, 120));
    }
  }
  if (failedPositions > 0) throw new Error('position read incomplete: ' + failedPositions + ' failed; refusing partial report');
  saveCache(cache);

  const totalFees = rows.reduce((sum, row) => sum + (row.feeUsd || 0), 0);
  const totalHype = rows.reduce((sum, row) => sum + row.feeHype, 0);
  const totalKntq = rows.reduce((sum, row) => sum + row.feeKntq, 0);
  const totalClaimed = Object.values(claimBook).reduce((sum, row) => sum + Number(row.usd || 0), 0);
  const pnlRows = rows.filter((row) => row.pnl != null);
  const totalPnl = pnlRows.length ? pnlRows.reduce((sum, row) => sum + row.pnl, 0) : null;
  const title = rows.length ? `💧 Elysium LP 待领 ${fmtUsd(totalFees)}` : '💧 Elysium LP 待领 $0.00';
  const lines = [
    `目前加上手续费收益净PNL：${totalPnl == null ? '—' : fmtSignedUsd(totalPnl)}`,
    `费用收入${fmtUsd(totalFees)}（${totalHype.toFixed(6)} HYPE + ${totalKntq.toFixed(4)} KNTQ）`
  ];
  if (totalClaimed > 0) lines.push(`已领手续费 ${fmtUsd(totalClaimed)}（计入PNL）`);
  if (rows.length === 1) {
    const row = rows[0];
    lines.push(`距离上区间 ${row.distUp == null ? '—' : row.distUp.toFixed(1) + '%'}   下区间 ${row.distDown == null ? '—' : row.distDown.toFixed(1) + '%'}`);
  } else if (rows.length > 1) {
    for (const row of rows) lines.push(`#${row.id} 距上${row.distUp == null ? '—' : row.distUp.toFixed(1) + '%'} 下${row.distDown == null ? '—' : row.distDown.toFixed(1) + '%'}`);
  } else {
    lines.push('距离上区间—  下区间—');
  }
  let hypeLine = 'HYPE合计 —';
  try {
    const kntq = new ethers.Contract(CONFIG.tokens.KNTQ.address, ABI.erc20, provider);
    const [nativeHype, kntqWallet] = await Promise.all([
      nativeBalance(OWNER),
      kntq.balanceOf(OWNER)
    ]);
    const elyHype = Number(ethers.formatUnits(nativeHype, 18)) + (hypeUsd > 0 ? Number(ethers.formatUnits(kntqWallet, 18)) * kntqUsd / hypeUsd : 0);
    const hyperHype = Number(ethers.formatUnits(await hyperEvmBalance(OWNER), 18));
    const lpUsd = rows.reduce((sum, row) => sum + (row.principalUsd || 0) + (row.feeUsd || 0), 0);
    const lpHype = hypeUsd > 0 ? lpUsd / hypeUsd : null;
    if (lpHype != null) {
      const totalHype = elyHype + lpHype + hyperHype;
      const ref = Number(CONFIG.ui?.hypeReference || 0);
      hypeLine = `HYPE合计 ${totalHype.toFixed(4)}（Elysium ${elyHype.toFixed(4)} + LP ${lpHype.toFixed(4)} + HyperEVM ${hyperHype.toFixed(4)}）` + (ref > 0 ? `｜参考${ref.toFixed(2)}｜${totalHype - ref >= 0 ? '+' : ''}${(totalHype - ref).toFixed(4)}` : '');
    }
  } catch (error) {
    console.log('[hype-total]', String(error.message || error).slice(0, 120));
  }
  lines.push(hypeLine);
  lines.push(new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }));
  console.log(title);
  console.log(lines.join('\n'));
  await postBark(title, lines.join('\n'));
}

async function nativeBalance(owner) {
  let lastError = null;
  // Prefer the secondary RPC for the periodic job: the official endpoint
  // rate-limits bursts, while the fallback keeps full position reads.
  const reportEndpoints = [...CONFIG.network.rpcUrls].reverse();
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
  const response = await fetch('https://rpc.hyperliquid.xyz/evm', {
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
  const reportEndpoints = [...CONFIG.network.rpcUrls].reverse();
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
