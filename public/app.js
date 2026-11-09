/* global ethers, LPMath, LPAbi */
(function () {
  'use strict';

  const M = window.LPMath;
  const ABI = window.LPAbi;
  const ZERO = '0x0000000000000000000000000000000000000000';
  const HEX_RE = /^0x[0-9a-fA-F]*$/;
  const MSG_SENDER = '0x0000000000000000000000000000000000000001';
  const Q128 = 1n << 128n;
  const MAX_UINT160 = (1n << 160n) - 1n;
  const MAX_UINT48 = (1n << 48n) - 1n;
  const STORAGE_PREFIX = 'elysium-lp:v2:';

  if (!window.ethers || !M || !ABI) {
    document.body.innerHTML = '<div class="noscript">依赖加载失败，请刷新页面。</div>';
    return;
  }

  const ui = {};
  [
    'appTitle', 'appSubtitle', 'networkBadge', 'rpcBadge', 'refreshBtn', 'connectBtn',
    'staleBanner', 'staleTitle', 'staleText', 'staleRefreshBtn', 'walletAddress', 'walletMenuBtn',
    'balanceHype', 'balanceKntq', 'kntqUsdBalance', 'marketPrice', 'marketAge', 'poolPrice',
    'sumPrincipal', 'sumPrincipalTokens', 'sumFees', 'sumFeesTokens', 'sumApr', 'sumPositions', 'sumEmpty',
    'hourApr', 'dayYield', 'shortApr', 'totalEntry', 'totalCurrent', 'totalPnl', 'totalPnlPct',
    'hypeEly', 'hypeLp', 'hypeHyper', 'hypeTotal', 'hypeMeta', 'hypeRefBadge',
    'sortSelect', 'hideClosed', 'positionsGrid', 'rangeNotice', 'positionsEmpty', 'emptyComposeBtn', 'emptyBurnBtn', 'cleanupEmptyBtn', 'composer',
    'hypeInput', 'kntqInput', 'maxHypeBtn', 'maxKntqBtn', 'amountUsd', 'amountRatio',
    'rangePresets', 'rangeLower', 'rangeLowerUsd', 'rangeCurrent',
    'rangeUpper', 'rangeUpperUsd', 'customRange', 'customLower', 'customUpper', 'slippageInput', 'slippageHint',
    'quoteState', 'quoteBudget', 'quoteHype', 'quoteKntq', 'quoteRatio', 'quoteRange', 'quoteFee', 'quoteSlip', 'quoteMin', 'quoteNote',
    'composerError', 'previewBtn', 'buildHypeBal', 'buildKntqBal', 'authState', 'reauthBtn', 'refreshBalBtn', 'sliderLower', 'sliderCurrent', 'sliderUpper', 'rangeMin', 'rangeMax', 'rangeSliderFill', 'rangeSliderCurrent', 'rangeZoomIn', 'rangeZoomOut', 'footerRpc', 'footerUpdated', 'modalBackdrop', 'modalTitle', 'modalEyebrow',
    'modalBody', 'modalClose', 'modalCancel', 'modalConfirm', 'toastStack',
    'chartTabs', 'chartInvert', 'priceChart', 'chartEmpty', 'chartLast', 'chartStats',
    'liquidityBars', 'distributionTag', 'distCurrentPrice', 'distAltPrice', 'distStatPrice', 'distHypePrice',
    'distActiveLiquidity', 'distMainRange', 'distMainShare', 'distCount', 'distributionAxis', 'liquidityTable'
  ].forEach((id) => { ui[id] = document.getElementById(id); });

  const iface = {
    erc20: new ethers.Interface(ABI.erc20),
    state: new ethers.Interface(ABI.stateView),
    pm: new ethers.Interface(ABI.positionManager),
    permit2: new ethers.Interface(ABI.permit2)
  };
  const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
  const multicallIface = new ethers.Interface([
    'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)'
  ]);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
  const SWAP_TOPIC = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');

  const state = {
    config: null,
    status: null,
    statusAt: 0,
    market: null,
    marketAt: 0,
    wallet: { address: null, chainId: null, provider: null, signer: null, connecting: false, readOnly: false },
    pool: null,
    balances: { hype: 0n, kntq: 0n },
    hyperEvmHype: null,
    positions: [],
    hiddenEmpty: 0,
    lastReadAt: 0,
    refreshing: false,
    loading: true,
    compose: {
      hype: '', kntq: '', lastEdited: 'hype', preset: '10', lower: '', upper: '', slippagePct: 0.5,
      quote: null, error: null, quoting: false, seq: 0,
      customLowerTick: null, customUpperTick: null, sliderMinTick: null, sliderMaxTick: null
    },
    chart: { tf: '5m', invert: false, candles: [], loading: false, seq: 0, cache: {} },
    distribution: { loading: false, at: 0 },
    retryTimer: null,
    apr: new Map(),
    snapshots: loadJson(STORAGE_PREFIX + 'snapshots', {}),
    firstSeen: loadJson(STORAGE_PREFIX + 'first-seen', {}),
    sort: readStorage('sort') || 'principal',
    hideClosed: readStorage('hide-closed') !== '0',
    positionIds: loadJson(STORAGE_PREFIX + 'position-ids', {}),
    entryCache: loadJson(STORAGE_PREFIX + 'entry-cache', {}),
    claims: {},
    forceLogs: false,
    modal: { onConfirm: null, busy: false }
  };

  function readStorage(key) { try { return localStorage.getItem(STORAGE_PREFIX + key); } catch (_) { return null; } }
  function writeStorage(key, value) { try { localStorage.setItem(STORAGE_PREFIX + key, value); } catch (_) { /* noop */ } }
  function loadJson(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } }
  function saveJson(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* noop */ } }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function shortAddress(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : '—'; }
  function fmtNum(v, digits) { if (!Number.isFinite(v)) return '—'; return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits == null ? 2 : digits }).format(v); }
  function fmtUsd(v, opts) {
    const o = opts || {};
    if (v == null || !Number.isFinite(v)) return '$—';
    if (v > 0 && v < 0.01 && !o.exact) return '<$0.01';
    const d = o.digits == null ? (v < 1 ? 4 : v < 1000 ? 2 : 0) : o.digits;
    return '$' + fmtNum(v, d);
  }
  function fmtSignedUsd(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    return (v >= 0 ? '+$' : '-$') + fmtNum(Math.abs(v), Math.abs(v) < 1 ? 4 : 2);
  }
  function fmtTinyUsd(v) {
    if (v == null || !Number.isFinite(v)) return '$—';
    if (v === 0) return '$0';
    const a = Math.abs(v);
    if (a < 1e-8) return (v < 0 ? '-' : '') + '$' + a.toExponential(2);
    if (a < 0.01) return (v < 0 ? '-' : '') + '$' + a.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
    return fmtUsd(v);
  }
  function fmtToken(v, decimals, digits) {
    if (v == null) return '—';
    try {
      const base = typeof v === 'bigint' ? v : BigInt(v);
      const text = ethers.formatUnits(base, decimals == null ? 18 : decimals);
      const numeric = Number(text);
      if (numeric > 0 && numeric < 1e-6) return '<0.000001';
      const [whole, frac] = text.split('.');
      const short = (frac || '').slice(0, digits == null ? 6 : digits).replace(/0+$/, '');
      return (whole === '0' ? '0' : fmtNum(Number(whole), 0)) + (short ? '.' + short : '');
    } catch (_) { return '—'; }
  }
  function fmtPrice(v, digits) {
    if (!Number.isFinite(v)) return '—';
    if (v === 0) return '0';
    if (v < 0.0001) return v.toPrecision(4);
    return fmtNum(v, digits == null ? 5 : digits);
  }
  function fmtPct(v) { if (v == null || !Number.isFinite(v)) return '观测中'; return fmtNum(v, Math.abs(v) < 10 ? 2 : 1) + '%'; }
  function fmtBps(v) { return fmtNum(Number(v) / 100, 2) + '%'; }
  function fmtAge(sec) { if (sec == null || !Number.isFinite(sec)) return '—'; if (sec < 5) return '刚刚'; if (sec < 60) return Math.floor(sec) + ' 秒前'; if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前'; return Math.floor(sec / 3600) + ' 小时前'; }
  function parseUnitsSafe(v, decimals) { const t = String(v == null ? '' : v).trim(); if (!/^\d*(?:\.\d*)?$/.test(t) || t === '' || t === '.') return 0n; try { return ethers.parseUnits(t, decimals || 18); } catch (_) { return 0n; } }
  function parseFloatSafe(v) { const n = Number(String(v == null ? '' : v).trim()); return Number.isFinite(n) ? n : NaN; }
  function toHexQty(v) { return '0x' + BigInt(v).toString(16); }
  function nowSec() { return Math.floor(Date.now() / 1000); }
  function getAddress(a) { try { return ethers.getAddress(a); } catch (_) { return a; } }
  function lower(a) { return String(a || '').toLowerCase(); }
  function int24(v) { const n = Number(v & 0xffffffn); return n >= 0x800000 ? n - 0x1000000 : n; }
  function decodeErr(error) {
    if (!error) return '未知错误';
    const raw = error.data?.data || error.data;
    const message = error.message || error.error?.message || String(error);
    if (typeof raw === 'string' && raw.startsWith('0x08c379a0')) {
      try { return ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + raw.slice(10))[0]; } catch (_) { /* noop */ }
    }
    if (typeof raw === 'string' && raw.startsWith('0x4e487b71')) {
      try { return '合约 Panic(' + ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], '0x' + raw.slice(10))[0] + ')'; } catch (_) { /* noop */ }
    }
    if (raw === '0x3b99b53d') return 'Uniswap V4 参数编码越界（SliceOutOfBounds），已停止';
    if (typeof raw === 'string' && raw.startsWith('0x12816f22')) return '最低数量未满足（MinimumAmountInsufficient）。价格在读取后发生了变化，请刷新后重试。';
    if (typeof raw === 'string' && raw.startsWith('0x31e30ad0')) return '数量上限被超过（MaximumAmountExceeded）。价格在签名前发生了变化，请刷新后重试或提高滑点。';
    if (typeof raw === 'string' && raw.startsWith('0x5212cba1')) return '结算未完成（CurrencyNotSettled）。请检查 KNTQ 授权/余额后重试。';
    return message.length > 260 ? message.slice(0, 260) + '…' : message;
  }

  async function fetchJson(url, opts) {
    const response = await fetch(url, Object.assign({ headers: { Accept: 'application/json' } }, opts || {}));
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_) { /* noop */ }
    if (!response.ok) throw new Error(payload?.error?.message || payload?.error || payload?.message || ('HTTP ' + response.status));
    if (!payload) throw new Error('服务返回空响应');
    return payload;
  }

  function claimsStorageKey(owner) {
    return STORAGE_PREFIX + 'claims:' + String(owner || '').toLowerCase();
  }

  async function loadClaims() {
    const owner = state.wallet.address;
    if (!owner) { state.claims = {}; return; }
    const local = loadJson(claimsStorageKey(owner), {});
    try {
      const response = await fetch('api/claims?owner=' + encodeURIComponent(owner), { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const payload = await response.json();
      const server = payload && payload.claims && typeof payload.claims === 'object' ? payload.claims : {};
      const merged = Object.assign({}, local, server);
      for (const [id, row] of Object.entries(local)) {
        if (!merged[id] || Number(row.usd || 0) > Number(merged[id].usd || 0)) merged[id] = row;
      }
      state.claims = merged;
      saveJson(claimsStorageKey(owner), merged);
    } catch (_) {
      state.claims = local;
    }
  }

  async function recordClaim(position, txHash) {
    const owner = state.wallet.address;
    if (!owner) return;
    const amount0 = Number(ethers.formatUnits(position.fees0, 18));
    const amount1 = Number(ethers.formatUnits(position.fees1, 18));
    const usd = Number(position.feesUsd || 0);
    if (!(usd > 0) && amount0 <= 0 && amount1 <= 0) return;
    try {
      const response = await fetch('api/claim', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ owner, tokenId: String(position.tokenId), amount0, amount1, usd, txHash: txHash || '' }) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const payload = await response.json();
      if (payload.claim) state.claims[String(position.tokenId)] = payload.claim;
    } catch (_) {
      const prev = state.claims[String(position.tokenId)] || {};
      state.claims[String(position.tokenId)] = { amount0: Number(prev.amount0 || 0) + amount0, amount1: Number(prev.amount1 || 0) + amount1, usd: Number(prev.usd || 0) + usd, count: Number(prev.count || 0) + 1, at: new Date().toISOString(), txHash: txHash || prev.txHash || '' };
      toast('已领取，记录待同步', '服务器记录失败，本机已保留。', 'error');
    }
    saveJson(claimsStorageKey(owner), state.claims);
  }

  async function clearClaim(tokenId) {
    const owner = state.wallet.address;
    if (!owner) return;
    delete state.claims[String(tokenId)];
    saveJson(claimsStorageKey(owner), state.claims);
    try {
      await fetch('api/claim/clear', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ owner, tokenId: String(tokenId) }) });
    } catch (_) { /* local cleanup still applies */ }
  }

  async function loadConfig() {
    const config = await fetchJson('api/config');
    state.config = config;
    document.title = (config.ui.title || 'Elysium LP') + ' · KNTQ/HYPE';
    ui.appTitle.textContent = config.ui.title || 'Elysium LP';
    ui.appSubtitle.textContent = config.ui.subtitle || 'Elysium · Uniswap V4';
    ui.networkBadge.textContent = config.network.name;
    ui.networkBadge.title = 'chainId ' + config.network.chainId;
    if (ui.slippageInput) {
      ui.slippageInput.value = String((config.safety.defaultSlippageBps || 50) / 100);
      ui.slippageInput.max = String(Math.min(5, (config.safety.maxSlippageBps || 300) / 100));
      state.compose.slippagePct = Number(ui.slippageInput.value);
    }
    ui.hideClosed.checked = state.hideClosed;
    if (ui.hypeRefBadge) { const ref = Number(config.ui?.hypeReference || 0); ui.hypeRefBadge.textContent = ref > 0 ? '参考 ' + fmtNum(ref, 2) : 'HYPE 本位'; }
    ui.sortSelect.value = state.sort;
    const watchAddress = config.ui?.defaultAddress;
    if (watchAddress) {
      state.wallet.address = getAddress(watchAddress);
      state.wallet.chainId = Number(config.network.chainId);
      state.wallet.readOnly = true;
    }
    updateStaleUi();
  }

  async function loadStatus() {
    try {
      const status = await fetchJson('api/status');
      state.status = status;
      state.statusAt = Date.now();
      if (status.market) { state.market = status.market; state.marketAt = Date.now(); }
      updateStatusUi();
      updateStaleUi();
    } catch (_) {
      state.status = null;
      state.statusAt = Date.now();
      updateStatusUi(true);
    }
  }

  async function loadMarket() {
    try {
      const market = await fetchJson('api/market');
      state.market = market;
      state.marketAt = Date.now();
      updateMarketUi();
      updateStaleUi();
    } catch (_) { /* keep status snapshot */ }
  }

  function marketAgeSec() {
    if (!state.market || state.market.price == null) return null;
    const base = Number(state.market.ageSec);
    return Number.isFinite(base) ? base + (Date.now() - state.marketAt) / 1000 : null;
  }
  function headAgeSec() {
    if (!state.status?.head || state.status.head.ageSec == null) return null;
    return Number(state.status.head.ageSec) + (Date.now() - state.statusAt) / 1000;
  }
  function isMarketStale() {
    if (!state.market || !(state.market.price > 0)) return true;
    const age = marketAgeSec();
    return age == null || age > Number(state.config?.market.staleSeconds || 90) || !!state.market.stale;
  }
  function isHeadStale() {
    if (!state.status?.head || !state.status.head.ok) return true;
    const age = headAgeSec();
    return age == null || age > Number(state.config?.safety.staleQuoteSeconds || 45);
  }
  function isSnapshotStale() { return !state.pool || !state.lastReadAt || (Date.now() - state.lastReadAt) / 1000 > Number(state.config?.safety.snapshotStaleSeconds || 120); }
  function txBlocked() { return isHeadStale() || isSnapshotStale(); }

  function updateStatusUi(error) {
    if (error || !state.status) {
      ui.rpcBadge.textContent = 'RPC 异常';
      ui.rpcBadge.className = 'pill rpc bad';
      ui.footerRpc.textContent = 'RPC —';
      return;
    }
    const s = state.status;
    ui.rpcBadge.textContent = 'RPC ' + (s.rpc?.active || '—');
    ui.rpcBadge.className = 'pill rpc ' + (s.ok ? 'good' : 'bad');
    ui.footerRpc.textContent = 'RPC ' + (s.rpc?.active || '—') + ' · chain ' + (s.chainId || '—');
    updateMarketUi();
  }

  function updateMarketUi() {
    if (!state.market || state.market.price == null) {
      ui.marketPrice.textContent = 'HYPE $—';
      ui.marketAge.textContent = '行情不可用';
      if (ui.kntqUsdBalance) ui.kntqUsdBalance.textContent = '≈ $—';
      return;
    }
    ui.marketPrice.textContent = 'HYPE ' + fmtUsd(state.market.price, { digits: 2 });
    ui.marketAge.textContent = '行情 ' + fmtAge(marketAgeSec()) + (isMarketStale() ? ' · 过期' : '');
    const k = kntqUsd();
    if (k != null && ui.kntqUsdBalance) ui.kntqUsdBalance.textContent = '≈ ' + fmtUsd(k * Number(ethers.formatUnits(state.balances.kntq, 18)));
    if (state.pool && kntqUsd() != null) ui.poolPrice.textContent = 'KNTQ ' + fmtUsd(kntqUsd(), { digits: 4 });
  }

  function kntqUsd() {
    if (!state.pool || !state.market || !(state.market.price > 0)) return null;
    return state.market.price / state.pool.rawPrice;
  }

  function updateWalletUi() {
    const connected = !!state.wallet.address;
    if (ui.connectBtn) ui.connectBtn.textContent = connected ? shortAddress(state.wallet.address) : '连接钱包';
    if (ui.buildHypeBal) ui.buildHypeBal.textContent = connected ? fmtToken(state.balances.hype, 18, 4) + ' HYPE' : '—';
    if (ui.buildKntqBal) ui.buildKntqBal.textContent = connected ? fmtToken(state.balances.kntq, 18, 5) + ' KNTQ' : '—';
    if (ui.walletAddress) {
      ui.walletAddress.textContent = connected ? shortAddress(state.wallet.address) : '未连接';
      ui.walletAddress.title = connected ? state.wallet.address : '';
    }
    if (ui.walletMenuBtn) ui.walletMenuBtn.hidden = !connected;
    if (!connected) {
      if (ui.balanceHype) ui.balanceHype.textContent = '—';
      if (ui.balanceKntq) ui.balanceKntq.textContent = '—';
      if (ui.kntqUsdBalance) ui.kntqUsdBalance.textContent = '≈ $—';
      return;
    }
    if (ui.balanceHype) {
      ui.balanceHype.textContent = fmtToken(state.balances.hype, 18, 5);
      ui.balanceHype.title = ethers.formatUnits(state.balances.hype, 18) + ' HYPE';
    }
    if (ui.balanceKntq) {
      ui.balanceKntq.textContent = fmtToken(state.balances.kntq, 18, 4);
      ui.balanceKntq.title = ethers.formatUnits(state.balances.kntq, 18) + ' KNTQ';
    }
    if (ui.kntqUsdBalance) {
      const k = kntqUsd();
      ui.kntqUsdBalance.textContent = k == null ? '≈ $—' : '≈ ' + fmtUsd(k * Number(ethers.formatUnits(state.balances.kntq, 18)));
    }
  }

  function updateStaleUi() {
    if (!state.config || (!state.status && !state.pool)) { ui.staleBanner.hidden = true; return; }
    const marketStale = isMarketStale();
    const headStale = isHeadStale();
    const snapStale = isSnapshotStale();
    const blocked = headStale || snapStale;
    const stale = marketStale || blocked;
    ui.staleBanner.hidden = !stale;
    if (stale) {
      if (blocked) {
        ui.staleTitle.textContent = '链上快照已过期';
        ui.staleText.textContent = '正在自动重试拉取；过期数据不会用于构造交易。';
      } else {
        ui.staleTitle.textContent = 'HYPE 行情已过期';
        ui.staleText.textContent = '美元估值可能不准确。行情恢复前，添加流动性会保持锁定。';
      }
    }
    ui.refreshBtn.disabled = state.refreshing;
    updateComposerButtons();
  }

  function canPreview() {
    if (!state.wallet.address || state.wallet.chainId !== Number(state.config.network.chainId)) return false;
    if (txBlocked() || isMarketStale()) return false;
    return !!state.compose.quote && !state.compose.error;
  }

  function updateComposerButtons() {
    if (!ui.previewBtn || !state.config) return;
    if (!state.wallet.address) { ui.previewBtn.textContent = '连接钱包后预览'; ui.previewBtn.disabled = false; }
    else if (state.wallet.chainId !== Number(state.config.network.chainId)) { ui.previewBtn.textContent = '切换到 ' + state.config.network.name; ui.previewBtn.disabled = false; }
    else if (txBlocked() || isMarketStale()) { ui.previewBtn.textContent = '数据同步中…'; ui.previewBtn.disabled = true; }
    else if (state.compose.quoting) { ui.previewBtn.textContent = '正在计算…'; ui.previewBtn.disabled = true; }
    else { ui.previewBtn.textContent = '预览'; ui.previewBtn.disabled = !canPreview(); }
  }

  function toast(title, message, kind) {
    const node = document.createElement('div');
    node.className = 'toast ' + (kind || '');
    node.innerHTML = '<strong>' + escapeHtml(title) + '</strong>' + escapeHtml(message || '');
    ui.toastStack.appendChild(node);
    setTimeout(() => { node.style.opacity = '0'; node.style.transform = 'translateY(5px)'; setTimeout(() => node.remove(), 220); }, 5200);
  }

  function openModal(options) {
    state.modal.onConfirm = options.onConfirm || null;
    state.modal.busy = false;
    ui.modalEyebrow.textContent = options.eyebrow || 'TRANSACTION';
    ui.modalTitle.textContent = options.title || '交易预览';
    ui.modalBody.innerHTML = options.body || '';
    ui.modalConfirm.textContent = options.confirmText || '确认';
    ui.modalConfirm.disabled = !!options.confirmDisabled;
    ui.modalCancel.textContent = '取消';
    ui.modalBackdrop.hidden = false;
    document.body.style.overflow = 'hidden';
    ui.modalConfirm.onclick = async () => {
      if (!state.modal.onConfirm || state.modal.busy) return;
      state.modal.busy = true;
      ui.modalConfirm.disabled = true;
      const original = ui.modalConfirm.textContent;
      ui.modalConfirm.textContent = '执行中…';
      try { await state.modal.onConfirm(); }
      catch (error) {
        toast('操作未完成', decodeErr(error), 'error');
        ui.modalConfirm.textContent = original;
        ui.modalConfirm.disabled = false;
        state.modal.busy = false;
      }
    };
  }
  function closeModal(force) {
    if (state.modal.busy && !force) return;
    ui.modalBackdrop.hidden = true;
    document.body.style.overflow = '';
    state.modal.onConfirm = null;
    state.modal.busy = false;
    ui.modalBody.innerHTML = '';
  }

  let rpcSeq = 1;
  async function rpcRaw(method, params) {
    let lastError = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const { payload } = await rpcRequestWithRetry('api/rpc', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: rpcSeq++, method, params: params || [] })
        }, 3);
        if (!payload) throw new Error('RPC 返回空响应');
        if (payload.error) {
          if (rpcRateLimited(payload.error)) throw Object.assign(new Error('RPC 限流'), payload.error);
          throw Object.assign(new Error(payload.error.message || 'RPC error'), payload.error);
        }
        return payload.result;
      } catch (error) {
        lastError = error;
        if (attempt >= 3) break;
        await sleep(300 * (attempt + 1));
      }
    }
    throw lastError || new Error('RPC unavailable');
  }

  function rpcRateLimited(error) {
    if (!error) return false;
    const message = String(error.message || error || '').toLowerCase();
    return Number(error.code) === -32017 || message.includes('rate limit') || message.includes('too many requests') || message.includes('429');
  }

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  async function rpcRequestWithRetry(url, options, attempts) {
    let last = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
        const text = await response.text();
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch (_) { /* noop */ }
        if (response.ok) return { response, payload };
        last = new Error(payload?.error?.message || payload?.error || ('RPC HTTP ' + response.status));
        if (response.status !== 429 && response.status < 500) throw last;
      } catch (error) {
        last = error;
      } finally {
        clearTimeout(timer);
      }
      await sleep(250 * (attempt + 1));
    }
    throw last || new Error('RPC unavailable');
  }

  async function rpcBatchRaw(requests) {
    if (!requests.length) return [];
    const CHUNK = 4;
    const out = new Array(requests.length);
    for (let start = 0; start < requests.length; start += CHUNK) {
      const chunk = requests.slice(start, start + CHUNK);
      let pending = chunk.map((_, i) => i);
      for (let attempt = 0; attempt < 4 && pending.length; attempt += 1) {
        const ids = pending.map(() => rpcSeq++);
        const body = pending.map((localIndex, i) => ({ jsonrpc: '2.0', id: ids[i], method: chunk[localIndex].method, params: chunk[localIndex].params || [] }));
        let payload = null;
        try {
          const result = await rpcRequestWithRetry('api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }, 3);
          payload = result.payload;
        } catch (error) {
          if (attempt >= 3) throw error;
          await sleep(300 * (attempt + 1));
          continue;
        }
        if (!Array.isArray(payload)) throw new Error('RPC 批量返回格式异常');
        const byId = new Map(payload.map((item) => [item.id, item]));
        const next = [];
        for (let i = 0; i < pending.length; i += 1) {
          const localIndex = pending[i];
          const item = byId.get(ids[i]);
          if (!item) { next.push(localIndex); continue; }
          if (item.error && rpcRateLimited(item.error)) { next.push(localIndex); continue; }
          out[start + localIndex] = item;
        }
        pending = next;
        if (pending.length) await sleep(300 * (attempt + 1));
      }
      if (pending.length) throw new Error('RPC 限流，批量读取未完成');
      if (start + CHUNK < requests.length) await sleep(180);
    }
    return out;
  }

  async function batchCalls(calls) {
    if (!calls.length) return [];
    const canAggregate = calls.length > 1 && calls.every((c) => (!c.block || c.block === 'latest') && !c.from && !c.value);
    if (canAggregate) {
      try {
        const aggregate = calls.map((c) => ({ target: c.to, allowFailure: true, callData: c.data }));
        const raw = await ethCall(MULTICALL3, multicallIface.encodeFunctionData('aggregate3', [aggregate]));
        const [results] = multicallIface.decodeFunctionResult('aggregate3', raw);
        return results.map((row, i) => row.success
          ? { result: row.returnData }
          : { error: { code: 3, message: 'multicall subcall failed', data: row.returnData } });
      } catch (error) {
        console.warn('[multicall] fallback', decodeErr(error));
      }
    }
    const reqs = calls.map((c) => ({
      method: 'eth_call',
      params: [Object.assign({ to: c.to, data: c.data }, c.from ? { from: c.from } : {}, c.value ? { value: toHexQty(c.value) } : {}), c.block || 'latest']
    }));
    const res = await rpcBatchRaw(reqs);
    return calls.map((c, i) => res[i].error ? { error: res[i].error } : { result: res[i].result });
  }

  async function ethCall(to, data, opts) {
    const tx = { to, data };
    if (opts?.from) tx.from = opts.from;
    if (opts?.value) tx.value = toHexQty(opts.value);
    const result = await rpcRaw('eth_call', [tx, opts?.block || 'latest']);
    if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result)) throw new Error('eth_call 返回异常');
    return result;
  }
  async function estimateGas(to, data, opts) {
    const tx = { to, data };
    if (opts?.from) tx.from = opts.from;
    if (opts?.value) tx.value = toHexQty(opts.value);
    return BigInt(await rpcRaw('eth_estimateGas', [tx]));
  }
  function decodeCall(ifaceRef, fn, res) {
    if (!res || res.error) throw Object.assign(new Error(decodeErr(res?.error)), res?.error || {});
    return ifaceRef.decodeFunctionResult(fn, res.result);
  }
  function callData(ifaceRef, fn, args) { return ifaceRef.encodeFunctionData(fn, args || []); }

  async function readBlock() {
    const numberHex = await rpcRaw('eth_blockNumber', []);
    const block = await rpcRaw('eth_getBlockByNumber', [numberHex, false]);
    if (!block) throw new Error('无法读取最新区块');
    return { number: Number(BigInt(numberHex)), timestamp: Number(BigInt(block.timestamp)) };
  }

  async function readPool() {
    const cfg = state.config;
    const stateView = getAddress(cfg.uniswap.stateView);
    const poolId = cfg.uniswap.poolId;
    const calls = [
      { to: stateView, data: callData(iface.state, 'getSlot0', [poolId]) },
      { to: stateView, data: callData(iface.state, 'getLiquidity', [poolId]) },
      { to: stateView, data: callData(iface.state, 'poolManager') }
    ];
    const res = await batchCalls(calls);
    const slot0 = decodeCall(iface.state, 'getSlot0', res[0]);
    const liquidity = decodeCall(iface.state, 'getLiquidity', res[1])[0];
    const manager = getAddress(decodeCall(iface.state, 'poolManager', res[2])[0]);
    if (lower(manager) !== lower(cfg.uniswap.poolManager)) throw new Error('StateView 的 PoolManager 与配置不一致');
    if (Number(slot0[3]) !== Number(cfg.uniswap.fee)) throw new Error('池子 LP fee 与配置不一致');
    const sqrtPriceX96 = BigInt(slot0[0]);
    const tick = Number(slot0[1]);
    const rawPrice = M.priceFromSqrtX96(sqrtPriceX96);
    if (!(rawPrice > 0)) throw new Error('池子价格无效');
    return {
      poolId, sqrtPriceX96, tick,
      protocolFee: Number(slot0[2]),
      lpFee: Number(slot0[3]),
      liquidity: BigInt(liquidity),
      rawPrice,
      price: 1 / rawPrice,
      tickSpacing: Number(cfg.uniswap.tickSpacing),
      poolManager: manager
    };
  }

  async function readBalances() {
    if (!state.wallet.address) return { hype: 0n, kntq: 0n };
    const owner = state.wallet.address;
    const kntq = getAddress(state.config.tokens.KNTQ.address);
    const [hypeHex, kntqRaw] = await Promise.all([
      rpcRaw('eth_getBalance', [owner, 'latest']),
      ethCall(kntq, callData(iface.erc20, 'balanceOf', [owner]))
    ]);
    if (typeof hypeHex !== 'string' || !HEX_RE.test(hypeHex)) throw new Error('HYPE 余额返回异常');
    return { hype: BigInt(hypeHex), kntq: iface.erc20.decodeFunctionResult('balanceOf', kntqRaw)[0] };
  }

  async function refreshBalances() {
    if (!state.wallet.address) return null;
    const fresh = await readBalances();
    state.balances = fresh;
    updateWalletUi();
    updateComposeUi();
    updateAuthState();
    return fresh;
  }

  async function updateAuthState() {
    if (!ui.authState) return;
    if (!state.wallet.address) {
      ui.authState.textContent = '授权：—';
      if (ui.reauthBtn) ui.reauthBtn.hidden = true;
      return;
    }
    try {
      const a = await readAllowances(0n);
      const need = state.balances.kntq;
      const tokenOk = a.tokenToPermit2 >= need;
      const permitOk = a.permitAmount >= need;
      ui.authState.textContent = '授权：' + (tokenOk && permitOk ? '已就绪' : (!tokenOk ? '需授权 KNTQ→Permit2' : '需授权 Permit2'));
      ui.authState.className = tokenOk && permitOk ? 'gain' : 'loss';
      if (ui.reauthBtn) ui.reauthBtn.hidden = false;
    } catch (_) {
      ui.authState.textContent = '授权：读取失败';
      ui.authState.className = 'loss';
      if (ui.reauthBtn) ui.reauthBtn.hidden = false;
    }
  }

  function openReauth() {
    if (!state.wallet.address) { toast('请先连接钱包', '连接后才能授权。', 'error'); return; }
    if (!(state.balances.kntq > 0n)) { toast('KNTQ 余额为 0', '没有可授权的 KNTQ。', 'error'); return; }
    const token = getAddress(state.config.tokens.KNTQ.address);
    const permit2 = getAddress(state.config.uniswap.permit2);
    const pm = getAddress(state.config.uniswap.positionManager);
    const amount = state.balances.kntq;
    const steps = [
      { id: 'reauth-token', label: '授权 KNTQ → Permit2', detail: '授权当前余额 ' + fmtToken(amount, 18, 5) + ' KNTQ', to: token, data: callData(iface.erc20, 'approve', [permit2, amount]), value: 0n, kind: 'approve' },
      { id: 'reauth-permit2', label: '授权 Permit2 → PositionManager', detail: '有效期最大，仅限这个 PositionManager', to: permit2, data: callData(iface.permit2, 'approve', [token, pm, amount, MAX_UINT48]), value: 0n, kind: 'approve' }
    ];
    openModal({
      eyebrow: 'PERMIT2', title: '重新授权 KNTQ',
      body: '<div class="warning-box">这是显式重新授权，不会发交易建仓。授权额度为当前 KNTQ 余额，授权对象仅限 Uniswap V4 PositionManager。</div><div class="preview-section"><h4>执行步骤</h4><div class="preview-list">' + steps.map(planStepHtml).join('') + '</div></div>',
      confirmText: '模拟并授权',
      onConfirm: async () => {
        await executeSteps(steps, (step, i, phase) => {
          if (phase === 'simulating') setStepState(step.id, '模拟中…', 'pending');
          if (phase === 'signing') setStepState(step.id, '模拟通过 · 请在钱包确认', 'pending');
          if (phase === 'sent') setStepState(step.id, '已发送，等待确认', 'pending');
          if (phase === 'confirmed') setStepState(step.id, '已确认', '');
        });
        toast('授权完成', 'KNTQ / Permit2 授权已更新。', 'success');
        closeModal(true); await updateAuthState(); await refreshAll();
      }
    });
  }

  async function readHyperEvmBalance() {
    const url = state.config.ui?.hyperEvmRpc || 'https://rpc.hyperliquid.xyz/evm';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [state.wallet.address, 'latest'] }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error('HyperEVM HTTP ' + response.status);
      const payload = await response.json();
      if (!payload || payload.error || typeof payload.result !== 'string') throw new Error('HyperEVM balance failed');
      return BigInt(payload.result);
    } finally { clearTimeout(timer); }
  }

  function updateHypeUi() {
    if (!ui.hypeEly) return;
    const ref = Number(state.config?.ui?.hypeReference || 0);
    if (ui.hypeRefBadge) ui.hypeRefBadge.textContent = ref > 0 ? '参考 ' + fmtNum(ref, 2) : '实时';
    const active = state.positions.filter((p) => !p.closed);
    const lpUsd = active.reduce((sum, p) => sum + (p.principalUsd || 0) + (p.feesUsd || 0), 0);
    const hypeUsd = state.market?.price;
    const connected = !!state.wallet.address;
    const kUsd = kntqUsd();
    const kntqHype = connected && kUsd > 0 && hypeUsd > 0 ? Number(ethers.formatUnits(state.balances.kntq, 18)) * kUsd / hypeUsd : null;
    const ely = connected ? Number(ethers.formatUnits(state.balances.hype, 18)) + kntqHype : null;
    const hyper = state.hyperEvmHype == null ? null : Number(ethers.formatUnits(state.hyperEvmHype, 18));
    const lp = hypeUsd > 0 ? lpUsd / hypeUsd : null;
    const total = ely == null || hyper == null || lp == null ? null : ely + hyper + lp;
    ui.hypeEly.textContent = ely == null ? '—' : fmtNum(ely, 5);
    ui.hypeLp.textContent = lp == null ? '—' : fmtNum(lp, 4);
    ui.hypeHyper.textContent = hyper == null ? '—' : fmtNum(hyper, 5);
    ui.hypeTotal.textContent = total == null ? '—' : fmtNum(total, 4);
    ui.hypeTotal.classList.toggle('negative', total != null && ref > 0 && total < ref);
    if (!connected) {
      ui.hypeMeta.textContent = '连接钱包后计算';
    } else if (total == null) {
      ui.hypeMeta.textContent = 'HyperEVM 或行情暂不可用';
    } else if (ref > 0) {
      const delta = total - ref;
      ui.hypeMeta.textContent = '参考转入 ' + fmtNum(ref, 2) + ' HYPE · 差额 ' + (delta >= 0 ? '+' : '') + fmtNum(delta, 4) + ' HYPE';
    } else {
      ui.hypeMeta.textContent = 'HYPE 本位合计';
    }
  }

  async function getLogsChunked(filter, chunkSize) {
    const size = Number(chunkSize || 100000);
    const from = Number(BigInt(filter.fromBlock));
    const to = filter.toBlock === 'latest' ? Number(BigInt(await rpcRaw('eth_blockNumber', []))) : Number(BigInt(filter.toBlock));
    if (to - from + 1 > size) {
      const logs = [];
      for (let start = from; start <= to; start += size) {
        const end = Math.min(to, start + size - 1);
        const part = await rpcRaw('eth_getLogs', [Object.assign({}, filter, { fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16) })]);
        logs.push(...part);
      }
      return logs;
    }
    return await rpcRaw('eth_getLogs', [filter]);
  }

  function positionKey(tokenId, tickLower, tickUpper) {
    return ethers.keccak256(ethers.solidityPacked(
      ['address', 'int24', 'int24', 'bytes32'],
      [getAddress(state.config.uniswap.positionManager), tickLower, tickUpper, ethers.zeroPadValue(ethers.toBeHex(tokenId), 32)]
    ));
  }

  function feeFromGrowth(liquidity, current, last) {
    if (liquidity <= 0n) return 0n;
    const delta = (current - last + (1n << 256n)) % (1n << 256n);
    return (liquidity * delta) >> 128n;
  }

  async function readPositions(block) {
    const owner = state.wallet.address;
    if (!owner) return { positions: [], hidden: 0 };
    const cfg = state.config;
    const pm = getAddress(cfg.uniswap.positionManager);
    const cacheKey = owner.toLowerCase();
    const cached = state.positionIds[cacheKey];
    let balance = null;
    try {
      balance = Number(BigInt(await ethCall(pm, callData(iface.pm, 'balanceOf', [owner]))));
    } catch (_) { /* cache fallback */ }
    let ids = [];
    let mintBlocks = new Map();
    if (cached && balance != null && Number(cached.balance) === balance && (cached.ids || []).length >= balance && Date.now() - cached.at < 2 * 60 * 1000 && !state.forceLogs) {
      ids = (cached.ids || []).map((id) => BigInt(id));
      mintBlocks = new Map(Object.entries(cached.mintBlocks || {}).map(([k, v]) => [k, Number(v)]));
    } else {
      const logs = await getLogsChunked({
        address: pm,
        fromBlock: '0x' + Number(cfg.uniswap.deploymentBlock).toString(16),
        toBlock: 'latest',
        topics: [TRANSFER_TOPIC, null, '0x' + owner.slice(2).toLowerCase().padStart(64, '0')]
      }, 3000000);
      const seen = new Set();
      for (const log of logs) {
        if (!log.topics || log.topics.length < 4) continue;
        const id = BigInt(log.topics[3]).toString();
        if (String(log.topics[1]).toLowerCase() === '0x' + '0'.repeat(64)) mintBlocks.set(id, Number(BigInt(log.blockNumber)));
        if (!seen.has(id)) { seen.add(id); ids.push(BigInt(id)); }
      }
      if (balance != null && ids.length < balance) throw new Error('仓位日志读取不完整，已保留旧数据');
      state.positionIds[cacheKey] = { ids: ids.map(String), mintBlocks: Object.fromEntries(mintBlocks), balance, at: Date.now() };
      saveJson(STORAGE_PREFIX + 'position-ids', state.positionIds);
      state.forceLogs = false;
    }
    if (!ids.length) return { positions: [], hidden: 0 };
    const owners = await batchCalls(ids.map((id) => ({ to: pm, data: callData(iface.pm, 'ownerOf', [id]) })));
    if (owners.some((row) => row.error && rpcRateLimited(row.error))) throw new Error('ownerOf 读取被 RPC 限流，已保留旧仓位');
    const currentIds = ids.filter((id, i) => !owners[i].error && lower('0x' + owners[i].result.slice(-40)) === lower(owner));
    if (!currentIds.length) return { positions: [], hidden: 0 };
    const infos = await batchCalls(currentIds.map((id) => ({ to: pm, data: callData(iface.pm, 'getPoolAndPositionInfo', [id]) })));
    const liqs = await batchCalls(currentIds.map((id) => ({ to: pm, data: callData(iface.pm, 'getPositionLiquidity', [id]) })));
    if (infos.some((row) => row.error) || liqs.some((row) => row.error)) throw new Error('仓位详情读取失败，已保留旧仓位');
    const poolHigh = BigInt(cfg.uniswap.poolId) >> 56n;
    const base = [];
    for (let i = 0; i < currentIds.length; i += 1) {
      if (infos[i].error || liqs[i].error) continue;
      let decoded;
      try { decoded = iface.pm.decodeFunctionResult('getPoolAndPositionInfo', infos[i].result); } catch (_) { continue; }
      const info = BigInt(decoded[1]);
      if ((info >> 56n) !== poolHigh) continue;
      const tokenId = currentIds[i];
      const tickLower = int24((info >> 8n) & 0xffffffn);
      const tickUpper = int24((info >> 32n) & 0xffffffn);
      let liquidity;
      try { liquidity = iface.pm.decodeFunctionResult('getPositionLiquidity', liqs[i].result)[0]; } catch (_) { continue; }
      base.push({ tokenId, tickLower, tickUpper, liquidity, mintBlock: mintBlocks.get(tokenId.toString()) || null, positionKey: positionKey(tokenId, tickLower, tickUpper) });
    }
    if (!base.length) return { positions: [], hidden: 0 };
    const feeCalls = [];
    for (const p of base) {
      feeCalls.push({ to: getAddress(cfg.uniswap.stateView), data: callData(iface.state, 'getPositionInfo', [cfg.uniswap.poolId, p.positionKey]) });
      feeCalls.push({ to: getAddress(cfg.uniswap.stateView), data: callData(iface.state, 'getFeeGrowthInside', [cfg.uniswap.poolId, p.tickLower, p.tickUpper]) });
    }
    const feeRes = await batchCalls(feeCalls);
    const hypeUsd = state.market?.price || 0;
    const kUsd = state.pool && hypeUsd ? hypeUsd / state.pool.rawPrice : null;
    const positions = [];
    let hidden = 0;
    for (let i = 0; i < base.length; i += 1) {
      const p = base[i];
      const posInfo = feeRes[i * 2];
      const growth = feeRes[i * 2 + 1];
      if (posInfo.error || growth.error) continue;
      let pi, fg;
      try {
        pi = iface.state.decodeFunctionResult('getPositionInfo', posInfo.result);
        fg = iface.state.decodeFunctionResult('getFeeGrowthInside', growth.result);
      } catch (_) { continue; }
      const fees0 = feeFromGrowth(p.liquidity, fg[0], pi[1]);
      const fees1 = feeFromGrowth(p.liquidity, fg[1], pi[2]);
      const sqrtLower = M.tickToSqrtRatioX96(p.tickLower);
      const sqrtUpper = M.tickToSqrtRatioX96(p.tickUpper);
      const amounts = M.amountsForLiquidity(p.liquidity, sqrtLower, sqrtUpper, state.pool.sqrtPriceX96);
      const principalUsd = kUsd == null ? null : Number(ethers.formatUnits(amounts.amount0, 18)) * hypeUsd + Number(ethers.formatUnits(amounts.amount1, 18)) * kUsd;
      const feesUsd = kUsd == null ? null : Number(ethers.formatUnits(fees0, 18)) * hypeUsd + Number(ethers.formatUnits(fees1, 18)) * kUsd;
      const closed = p.liquidity === 0n && fees0 === 0n && fees1 === 0n;
      if (closed) hidden += 1;
      const firstKey = (state.wallet.address || '') + ':' + p.tokenId.toString();
      if (!state.firstSeen[firstKey]) { state.firstSeen[firstKey] = Date.now(); saveJson(STORAGE_PREFIX + 'first-seen', state.firstSeen); }
      positions.push(Object.assign({}, p, {
        sqrtLower, sqrtUpper, amount0: amounts.amount0, amount1: amounts.amount1,
        fees0, fees1, feeGrowthLast0: pi[1], feeGrowthLast1: pi[2], principalUsd, feesUsd, closed,
        inRange: state.pool.tick >= p.tickLower && state.pool.tick < p.tickUpper,
        rangeLower: 1 / M.priceFromSqrtX96(sqrtUpper),
        rangeUpper: 1 / M.priceFromSqrtX96(sqrtLower),
        firstSeen: state.firstSeen[firstKey]
      }));
    }
    return { positions, hidden };
  }

  async function attachPnl(positions, block) {
    const currentHype = state.market?.price;
    const currentK = kntqUsd();
    if (!(currentHype > 0) || !(currentK > 0)) return;
    const stateView = getAddress(state.config.uniswap.stateView);
    for (const p of positions) {
      const claim = state.claims[String(p.tokenId)] || {};
      p.claimedUsd = Number(claim.usd || 0);
      p.claimedCount = Number(claim.count || 0);
      p.claimed0 = Number(claim.amount0 || 0);
      p.claimed1 = Number(claim.amount1 || 0);
      if (!p.mintBlock || p.principalUsd == null) continue;
      const cacheKey = p.tokenId.toString() + ':' + p.mintBlock;
      let entry = state.entryCache[cacheKey];
      if (!entry) {
        try {
          const tag = '0x' + Number(p.mintBlock).toString(16);
          const [header, res] = await Promise.all([
            rpcRaw('eth_getBlockByNumber', [tag, false]),
            batchCalls([
              { to: stateView, block: tag, data: callData(iface.state, 'getSlot0', [state.config.uniswap.poolId]) },
              { to: getAddress(state.config.uniswap.positionManager), block: tag, data: callData(iface.pm, 'getPositionLiquidity', [p.tokenId]) }
            ])
          ]);
          if (!header || res[0].error || res[1].error) continue;
          const slot0 = iface.state.decodeFunctionResult('getSlot0', res[0].result);
          let liqMint = iface.pm.decodeFunctionResult('getPositionLiquidity', res[1].result)[0];
          let estimated = false;
          if (liqMint === 0n) { liqMint = p.liquidity; estimated = true; }
          if (liqMint !== p.liquidity) estimated = true;
          const sqrtMint = BigInt(slot0[0]);
          if (!(sqrtMint > 0n)) continue;
          const rawMint = M.priceFromSqrtX96(sqrtMint);
          const mintTs = Number(BigInt(header.timestamp));
          let hypeAt = null;
          try {
            const hist = await fetchJson('api/hype-history?ts=' + mintTs);
            hypeAt = hist.price;
          } catch (_) { /* fallback */ }
          if (!(hypeAt > 0)) { hypeAt = currentHype; estimated = true; }
          const kntqAt = rawMint > 0 ? hypeAt / rawMint : currentK;
          const amounts = M.amountsForLiquidity(liqMint, p.sqrtLower, p.sqrtUpper, sqrtMint);
          const valueUsd = Number(ethers.formatUnits(amounts.amount0, 18)) * hypeAt + Number(ethers.formatUnits(amounts.amount1, 18)) * kntqAt;
          entry = {
            valueUsd, hypeAt, kntqAt, mintTs,
            amount0: amounts.amount0.toString(), amount1: amounts.amount1.toString(),
            estimated, at: Date.now()
          };
          state.entryCache[cacheKey] = entry;
          saveJson(STORAGE_PREFIX + 'entry-cache', state.entryCache);
        } catch (_) { continue; }
      }
      p.entry = entry;
      p.entryValueUsd = entry.valueUsd;
      p.currentValueUsd = p.principalUsd + (p.feesUsd || 0) + (p.claimedUsd || 0);
      p.pnlUsd = p.principalUsd + (p.feesUsd || 0) + (p.claimedUsd || 0) - entry.valueUsd;
      p.pnlPct = entry.valueUsd > 0 ? p.pnlUsd / entry.valueUsd * 100 : null;
      p.entryAgeSec = Math.max(0, block.timestamp - entry.mintTs);
      const hodl = Number(ethers.formatUnits(BigInt(entry.amount0), 18)) * currentHype + Number(ethers.formatUnits(BigInt(entry.amount1), 18)) * currentK;
      p.hodlValueUsd = hodl;
      p.ilUsd = p.principalUsd - hodl;
    }
  }

  function usdFees(f0, f1) {
    const h = state.market?.price;
    const k = kntqUsd();
    if (!(h > 0) || k == null) return null;
    return Number(ethers.formatUnits(f0, 18)) * h + Number(ethers.formatUnits(f1, 18)) * k;
  }

  function snapshotKey(tokenId) { return (state.wallet.address || 'anon') + ':' + tokenId.toString(); }
  function getPoints(tokenId) {
    const key = snapshotKey(tokenId);
    if (!Array.isArray(state.snapshots[key])) state.snapshots[key] = [];
    return state.snapshots[key];
  }
  function appendPoint(tokenId, fees0, fees1) {
    const key = snapshotKey(tokenId);
    const points = getPoints(tokenId);
    const now = Date.now();
    const last = points[points.length - 1];
    if (last && now - last.t < 15000) { last.f0 = fees0.toString(); last.f1 = fees1.toString(); }
    else points.push({ t: now, f0: fees0.toString(), f1: fees1.toString() });
    state.snapshots[key] = points.filter((p) => p.t >= now - 30 * 60 * 1000).slice(-80);
    saveJson(STORAGE_PREFIX + 'snapshots', state.snapshots);
  }

  async function estimateBlockSeconds(block) {
    try {
      const sample = 10000;
      const old = await rpcRaw('eth_getBlockByNumber', ['0x' + Math.max(1, block.number - sample).toString(16), false]);
      const elapsed = block.timestamp - Number(BigInt(old.timestamp));
      if (elapsed > 0) return elapsed / sample;
    } catch (_) { /* fallback */ }
    return Number(state.config.safety.blockTimeSeconds || 0.18);
  }

  async function attachApr(positions, block) {
    if (!positions.length) return;
    appendPointForPositions(positions);
    const secPerBlock = await estimateBlockSeconds(block);
    const windows = [
      { key: '5m', label: '5 分钟', seconds: 300 },
      { key: '30m', label: '30 分钟', seconds: 1800 },
      { key: '1h', label: '1 小时', seconds: 3600 }
    ];
    const blocks = windows.map((w) => Math.max(1, Math.round(w.seconds / Math.max(0.02, secPerBlock))));
    const tags = blocks.map((n) => '0x' + Math.max(1, block.number - n).toString(16));
    let headers = [];
    try {
      headers = await Promise.all(tags.map((tag) => rpcRaw('eth_getBlockByNumber', [tag, false])));
    } catch (_) { headers = []; }

    const stateView = getAddress(state.config.uniswap.stateView);
    const calls = [];
    for (const p of positions) {
      for (const tag of tags) {
        calls.push({ to: stateView, block: tag, data: callData(iface.state, 'getFeeGrowthInside', [state.config.uniswap.poolId, p.tickLower, p.tickUpper]) });
      }
    }
    let results = [];
    try { results = await batchCalls(calls); } catch (_) { results = []; }

    for (let pi = 0; pi < positions.length; pi += 1) {
      const p = positions[pi];
      const currentUsd = usdFees(p.fees0, p.fees1);
      const perWindow = {};
      for (let wi = 0; wi < windows.length; wi += 1) {
        const row = results[pi * windows.length + wi];
        const header = headers[wi];
        if (!row || row.error || !header) { perWindow[windows[wi].key] = null; continue; }
        let fg;
        try { fg = iface.state.decodeFunctionResult('getFeeGrowthInside', row.result); } catch (_) { perWindow[windows[wi].key] = null; continue; }
        const past0 = feeFromGrowth(p.liquidity, fg[0], p.feeGrowthLast0);
        const past1 = feeFromGrowth(p.liquidity, fg[1], p.feeGrowthLast1);
        const elapsed = block.timestamp - Number(BigInt(header.timestamp));
        const pastUsd = usdFees(past0, past1);
        if (currentUsd == null || pastUsd == null || elapsed < 45 || currentUsd < pastUsd) { perWindow[windows[wi].key] = null; continue; }
        const apr = M.annualizedPercent(currentUsd, pastUsd, p.principalUsd, elapsed);
        const perSecond = M.perSecondUsd(currentUsd, pastUsd, elapsed);
        perWindow[windows[wi].key] = { apr, perSecond, elapsed, label: windows[wi].label };
      }
      const age = p.mintBlock ? Math.max(0, (block.number - p.mintBlock) * secPerBlock) : null;
      if (age != null && age > 55 && age < 3600 && currentUsd != null && p.principalUsd) {
        const apr = M.annualizedPercent(currentUsd, 0, p.principalUsd, age);
        perWindow.since = { apr, perSecond: M.perSecondUsd(currentUsd, 0, age), elapsed: age, label: '建仓以来' };
      }
      const chosenKey = ['30m', '1h', '5m', 'since'].find((k) => perWindow[k]);
      const chosen = chosenKey ? perWindow[chosenKey] : null;
      p.aprWindows = perWindow; p.ageSec = age;
      p.apr = chosen ? chosen.apr : null;
      p.perSecond = chosen ? chosen.perSecond : null;
      p.aprSource = chosen ? chosen.label + '链上 feeGrowth' : null;
      p.aprWindow = chosen ? chosen.label : null;
      p.dayYield = p.principalUsd != null && p.apr != null ? p.principalUsd * (p.apr / 100) / 365 : null;
      p.aprPoints = getPoints(p.tokenId);
      // Local fallback: only when no on-chain window works (fresh position / collected fees).
      if (p.apr == null) {
        const points = getPoints(p.tokenId);
        if (points.length >= 2) {
          const first = points[0];
          const elapsed = (Date.now() - first.t) / 1000;
          const baseUsd = usdFees(BigInt(first.f0), BigInt(first.f1));
          if (elapsed >= 55 && currentUsd != null && baseUsd != null && currentUsd >= baseUsd) {
            p.apr = M.annualizedPercent(currentUsd, baseUsd, p.principalUsd, elapsed);
            p.perSecond = M.perSecondUsd(currentUsd, baseUsd, elapsed);
            p.aprSource = '本机观测 ' + M.formatDuration(elapsed);
            p.aprWindow = M.formatDuration(elapsed);
            p.dayYield = p.principalUsd != null ? p.principalUsd * (p.apr / 100) / 365 : null;
          }
        }
      }
      state.apr.set(p.tokenId.toString(), { apr: p.apr, windows: perWindow, at: Date.now() });
    }
  }

  function appendPointForPositions(positions) {
    for (const p of positions) appendPoint(p.tokenId, p.fees0, p.fees1);
  }

  async function refreshAll() {
    if (state.refreshing) { state.refreshPending = true; return; }
    state.refreshing = true;
    state.refreshPending = false;
    updateStaleUi();
    try {
      const block = await readBlock();
      state.block = block;
      const pool = await readPool();
      state.pool = pool;
      let balances = { hype: 0n, kntq: 0n };
      let positions = [];
      let hidden = 0;
      if (state.wallet.address && state.wallet.chainId === Number(state.config.network.chainId)) {
        try { balances = await readBalances(); } catch (error) { console.warn('[balances]', decodeErr(error)); balances = state.balances; }
        updateAuthState();
        const claimsPromise = loadClaims();
        const result = await readPositions(block);
        positions = result.positions;
        hidden = result.hidden;
        await claimsPromise;
        state.balances = balances;
        state.positions = positions;
        state.hiddenEmpty = hidden;
        state.lastReadAt = Date.now();
        state.loading = false;
        // Paint the position list before expensive entry/APR work.
        updateWalletUi();
        renderPositions();
        updateSummary();
        updateHypeUi();
        updateStaleUi();
        // HYPE wallet balance is independent; do not block the first paint on it.
        readHyperEvmBalance().then((value) => { state.hyperEvmHype = value; updateHypeUi(); }).catch(() => { state.hyperEvmHype = null; updateHypeUi(); });
        await attachPnl(positions, block);
        state.positions = positions;
        renderPositions();
        updateSummary();
        updateHypeUi();
        updateStaleUi();
        await attachApr(positions, block);
      }
      if (state.wallet.address && state.wallet.chainId !== Number(state.config.network.chainId)) { /* keep empty */ }
      state.balances = balances;
      state.positions = positions;
      state.hiddenEmpty = hidden;
      state.lastReadAt = Date.now();
      state.loading = false;
      if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null; }
      updateStatusUi();
      updateMarketUi();
      updateWalletUi();
      renderPositions();
      updateSummary();
      updateHypeUi();
      updateComposeUi();
      updateStaleUi();
      scheduleQuote(true);
      scheduleChart();
      scheduleDistribution();
    } catch (error) {
      state.loading = false;
      updateStaleUi();
      renderPositions();
      scheduleRetry();
      toast('链上读取失败，自动重试中', decodeErr(error), 'error');
    } finally {
      state.refreshing = false;
      updateStaleUi();
    }
  }

  async function ensureWalletChain(interactive) {
    if (!window.ethereum) throw new Error('未检测到浏览器钱包扩展');
    const cfg = state.config.network;
    let hex = await window.ethereum.request({ method: 'eth_chainId' });
    if (Number(BigInt(hex)) === Number(cfg.chainId)) { state.wallet.chainId = Number(cfg.chainId); return; }
    if (!interactive) { state.wallet.chainId = Number(BigInt(hex)); return; }
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: cfg.chainIdHex }] });
    } catch (error) {
      if (Number(error.code) !== 4902) throw error;
      const isOkx = !!window.okxwallet || !!window.ethereum?.isOkxWallet || /OKX/i.test(navigator.userAgent);
      if (isOkx) throw new Error('OKX 内置 Elysium 主网未找到，请在 OKX 网络列表选择 Elysium（99901），不要新增自定义网络');
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: cfg.chainIdHex,
          chainName: cfg.name,
          nativeCurrency: { name: cfg.nativeSymbol, symbol: cfg.nativeSymbol, decimals: 18 },
          rpcUrls: [cfg.rpcUrls[0].url],
          blockExplorerUrls: [cfg.explorer]
        }]
      });
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: cfg.chainIdHex }] });
    }
    hex = await window.ethereum.request({ method: 'eth_chainId' });
    state.wallet.chainId = Number(BigInt(hex));
    if (state.wallet.chainId !== Number(cfg.chainId)) throw new Error('钱包仍不在 ' + cfg.name);
  }

  async function setupProvider() {
    const provider = new ethers.BrowserProvider(window.ethereum, 'any');
    state.wallet.provider = provider;
    state.wallet.signer = await provider.getSigner();
  }

  async function connectWallet() {
    if (state.wallet.connecting) return;
    if (!window.ethereum) {
      openModal({ eyebrow: 'WALLET', title: '没有检测到浏览器钱包', body: '<div class="warning-box">请安装 MetaMask / Rabby / OKX Wallet，然后刷新页面。工具不会索要助记词或私钥。</div>', confirmText: '知道了', onConfirm: async () => closeModal(true) });
      return;
    }
    state.wallet.connecting = true;
    ui.connectBtn.disabled = true;
    ui.connectBtn.textContent = '连接中…';
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      if (!accounts?.length) throw new Error('钱包没有返回账户');
      await ensureWalletChain(true);
      state.wallet.address = getAddress(accounts[0]);
      state.wallet.readOnly = false;
      state.apr.clear();
      state.forceLogs = true;
      await setupProvider();
      updateWalletUi();
      toast('钱包已连接', shortAddress(state.wallet.address), 'success');
      await refreshAll();
    } catch (error) {
      toast('连接失败', decodeErr(error), 'error');
      updateWalletUi();
    } finally {
      state.wallet.connecting = false;
      ui.connectBtn.disabled = false;
      updateComposerButtons();
    }
  }

  function disconnectWallet() {
    state.wallet = { address: null, chainId: null, provider: null, signer: null, connecting: false, readOnly: false };
    state.balances = { hype: 0n, kntq: 0n };
    state.hyperEvmHype = null;
    state.claims = {};
    state.positions = [];
    state.apr.clear();
    updateWalletUi();
    renderPositions();
    updateSummary();
    updateComposeUi();
    toast('已断开界面连接', '钱包扩展中的账户授权仍由钱包管理。');
  }

  async function onAccountsChanged(accounts) {
    if (state.wallet.readOnly) return;
    if (!accounts?.length) { disconnectWallet(); return; }
    state.wallet.address = getAddress(accounts[0]);
    state.apr.clear();
    try { await ensureWalletChain(true); await setupProvider(); } catch (error) { toast('网络切换失败', decodeErr(error), 'error'); }
    updateWalletUi();
    await refreshAll();
  }
  async function onChainChanged(hex) {
    if (state.wallet.readOnly) return;
    state.wallet.chainId = Number(BigInt(hex));
    if (state.wallet.chainId !== Number(state.config.network.chainId)) toast('网络不匹配', '请切换到 ' + state.config.network.name, 'error');
    else { try { await setupProvider(); } catch (_) { /* noop */ } }
    updateWalletUi();
    await refreshAll();
  }

  function sliderDomain() {
    const pool = state.pool;
    if (!pool) return null;
    if (state.compose.sliderMinTick == null || state.compose.sliderMaxTick == null) {
      state.compose.sliderMinTick = M.nearestUsableTick(pool.tick - 6000, pool.tickSpacing);
      state.compose.sliderMaxTick = M.nearestUsableTick(pool.tick + 6000, pool.tickSpacing);
    }
    return { min: state.compose.sliderMinTick, max: state.compose.sliderMaxTick };
  }

  function ensureCustomTicks() {
    const pool = state.pool;
    if (!pool) return;
    const domain = sliderDomain();
    if (state.compose.customLowerTick == null || state.compose.customUpperTick == null) {
      state.compose.customLowerTick = M.nearestUsableTick(pool.tick - 1000, pool.tickSpacing);
      state.compose.customUpperTick = M.nearestUsableTick(pool.tick + 1000, pool.tickSpacing);
    }
    state.compose.customLowerTick = Math.max(domain.min, Math.min(domain.max, Number(state.compose.customLowerTick)));
    state.compose.customUpperTick = Math.max(domain.min, Math.min(domain.max, Number(state.compose.customUpperTick)));
    if (!(state.compose.customLowerTick < state.compose.customUpperTick)) {
      state.compose.customLowerTick = Math.max(domain.min, state.compose.customUpperTick - pool.tickSpacing);
    }
  }

  function tickAtSlider(value) {
    const d = sliderDomain();
    if (!d) return 0;
    const raw = d.min + (d.max - d.min) * Number(value) / 1000;
    return M.nearestUsableTick(raw, state.pool.tickSpacing);
  }

  function sliderAtTick(tick) {
    const d = sliderDomain();
    if (!d || d.max === d.min) return 500;
    return Math.max(0, Math.min(1000, Math.round((Number(tick) - d.min) / (d.max - d.min) * 1000)));
  }

  function updateRangeSlider(range) {
    if (!ui.rangeMin || !ui.rangeMax) return;
    ensureCustomTicks();
    const d = sliderDomain();
    if (!d) return;
    const lower = state.compose.customLowerTick;
    const upper = state.compose.customUpperTick;
    const loPct = sliderAtTick(lower);
    const hiPct = sliderAtTick(upper);
    if (Number(ui.rangeMin.value) !== loPct) ui.rangeMin.value = String(loPct);
    if (Number(ui.rangeMax.value) !== hiPct) ui.rangeMax.value = String(hiPct);
    if (ui.rangeSliderFill) { ui.rangeSliderFill.style.left = loPct / 10 + '%'; ui.rangeSliderFill.style.right = (100 - hiPct / 10) + '%'; }
    if (ui.rangeSliderCurrent) {
      const cur = sliderAtTick(state.pool?.tick || 0);
      ui.rangeSliderCurrent.style.left = cur / 10 + '%';
      ui.rangeSliderCurrent.hidden = cur < 0 || cur > 1000;
    }
    if (ui.sliderLower) ui.sliderLower.textContent = range?.full ? '≈0' : (range ? fmtPrice(range.lowerPrice) : '—');
    if (ui.sliderUpper) ui.sliderUpper.textContent = range?.full ? '∞' : (range ? fmtPrice(range.upperPrice) : '—');
    if (ui.sliderCurrent) ui.sliderCurrent.textContent = state.pool ? fmtPrice(state.pool.price) : '—';
  }

  function applySliderTicks() {
    if (!ui.rangeMin || !ui.rangeMax) return;
    let lo = tickAtSlider(ui.rangeMin.value);
    let hi = tickAtSlider(ui.rangeMax.value);
    if (lo >= hi) {
      if (document.activeElement === ui.rangeMin) lo = Math.max(state.compose.sliderMinTick, hi - state.pool.tickSpacing);
      else hi = Math.min(state.compose.sliderMaxTick, lo + state.pool.tickSpacing);
    }
    state.compose.customLowerTick = lo;
    state.compose.customUpperTick = hi;
    try { updateRangeUi(selectedRange()); } catch (_) { /* quote will show error */ }
    scheduleQuote(true);
  }

  function zoomCustomRange(factor) {
    ensureCustomTicks();
    const d = sliderDomain();
    const mid = (state.compose.customLowerTick + state.compose.customUpperTick) / 2;
    let half = (state.compose.customUpperTick - state.compose.customLowerTick) * factor / 2;
    half = Math.max(state.pool.tickSpacing, Math.min(half, (d.max - d.min) / 2));
    state.compose.customLowerTick = M.nearestUsableTick(mid - half, state.pool.tickSpacing);
    state.compose.customUpperTick = M.nearestUsableTick(mid + half, state.pool.tickSpacing);
    if (!(state.compose.customLowerTick < state.compose.customUpperTick)) {
      state.compose.customLowerTick = d.min; state.compose.customUpperTick = d.max;
    }
    try { updateRangeUi(selectedRange()); } catch (_) { /* quote will show error */ }
    scheduleQuote(true);
  }

  function selectedRange() {
    const pool = state.pool;
    if (!pool) return null;
    if (state.compose.preset === 'full') {
      const lowerTick = M.nearestUsableTick(M.MIN_TICK, pool.tickSpacing);
      const upperTick = M.nearestUsableTick(M.MAX_TICK, pool.tickSpacing);
      return { lowerTick, upperTick, full: true, lowerPrice: 0, upperPrice: Infinity, rawLower: M.priceFromSqrtX96(M.tickToSqrtRatioX96(lowerTick)), rawUpper: M.priceFromSqrtX96(M.tickToSqrtRatioX96(upperTick)) };
    }
    if (state.compose.preset === 'custom') {
      ensureCustomTicks();
      const lowerTick = Number(state.compose.customLowerTick);
      const upperTick = Number(state.compose.customUpperTick);
      if (!Number.isInteger(lowerTick) || !Number.isInteger(upperTick) || !(lowerTick < upperTick)) throw new Error('拖动左右圆点设置有效区间');
      const rawLower = M.priceFromSqrtX96(M.tickToSqrtRatioX96(lowerTick));
      const rawUpper = M.priceFromSqrtX96(M.tickToSqrtRatioX96(upperTick));
      return { lowerTick, upperTick, full: false, lowerPrice: 1 / rawUpper, upperPrice: 1 / rawLower, rawLower, rawUpper };
    }
    const pct = Number(state.compose.preset);
    if (!(pct > 0) || pct > 99) throw new Error('区间百分比无效');
    const raw = M.rangeFromPercent(pool.tick, pool.tickSpacing, -pct, pct);
    return { lowerTick: raw.lowerTick, upperTick: raw.upperTick, full: false, lowerPrice: 1 / raw.upperPrice, upperPrice: 1 / raw.lowerPrice, rawLower: raw.lowerPrice, rawUpper: raw.upperPrice };
  }

  function updateRangeUi(range) {
    if (!range) {
      ui.rangeLower.textContent = '—'; ui.rangeLowerUsd.textContent = '$—';
      ui.rangeCurrent.textContent = '—'; ui.rangeUpper.textContent = '—'; ui.rangeUpperUsd.textContent = '$—';
      return;
    }
    ui.rangeLower.textContent = range.full ? '≈0' : fmtPrice(range.lowerPrice);
    ui.rangeUpper.textContent = range.full ? '∞' : fmtPrice(range.upperPrice);
    ui.rangeCurrent.textContent = state.pool ? fmtPrice(state.pool.price) : '—';
    const h = state.market?.price;
    ui.rangeLowerUsd.textContent = h && !range.full ? fmtUsd(range.lowerPrice * (kntqUsd() || 0)) : '$—';
    ui.rangeUpperUsd.textContent = h && !range.full ? fmtUsd(range.upperPrice * (kntqUsd() || 0)) : '$—';
    if (state.compose.preset === 'custom') updateRangeSlider(range);
  }

  function setInputValue(el, value) {
    if (!el) return;
    const text = value == null ? '' : String(value);
    if (document.activeElement === el && el.value === text) return;
    el.value = text;
  }

  function amountRatioText(a0, a1) {
    if (!(a0 > 0n) || !(a1 > 0n)) return '—';
    const h = Number(ethers.formatUnits(a0, 18));
    const k = Number(ethers.formatUnits(a1, 18));
    if (!(h > 0) || !(k > 0)) return '—';
    return '1 HYPE = ' + fmtNum(k / h, 4) + ' KNTQ';
  }

  async function computeQuote() {
    if (!ui.hypeInput) return;
    const seq = ++state.compose.seq;
    if (!state.config || !state.pool || !(state.market?.price > 0)) {
      state.compose.quote = null; state.compose.quoting = false; updateComposeUi(); updateComposerButtons(); return;
    }
    const hypeWei = parseUnitsSafe(state.compose.hype, 18);
    const kntqWei = parseUnitsSafe(state.compose.kntq, 18);
    if (hypeWei <= 0n && kntqWei <= 0n) {
      state.compose.quote = null; state.compose.error = null; state.compose.quoting = false;
      try { updateRangeUi(selectedRange()); } catch (_) { updateRangeUi(null); }
      updateComposeUi(); updateComposerButtons(); return;
    }
    state.compose.quoting = true;
    state.compose.error = null;
    updateComposerButtons();
    try {
      const range = selectedRange();
      updateRangeUi(range);
      if (!(range.lowerTick < range.upperTick)) throw new Error('区间无效');
      const sqrtLower = M.tickToSqrtRatioX96(range.lowerTick);
      const sqrtUpper = M.tickToSqrtRatioX96(range.upperTick);
      const sqrtCurrent = state.pool.sqrtPriceX96;
      const slipPct = parseFloatSafe(ui.slippageInput.value);
      const maxPct = Number(state.config.safety.maxSlippageBps || 300) / 100;
      if (!(slipPct > 0) || slipPct > maxPct) throw new Error('滑点必须在 0.01%–' + fmtNum(maxPct, 2) + '%');
      const slip = Math.max(1, Math.round(slipPct * 100));
      const gasReserve = parseUnitsSafe(state.config.safety.gasReserveHype || '0.02', 18);

      let liquidity;
      if (state.compose.lastEdited === 'kntq' && kntqWei > 0n) {
        liquidity = M.liquidityForAmount1AtPrice(kntqWei, sqrtLower, sqrtCurrent);
      } else {
        liquidity = M.liquidityForAmount0AtPrice(hypeWei, sqrtCurrent, sqrtUpper);
      }
      if (liquidity <= 0n) throw new Error('数量太小，或当前价格不在你选的价格区间内');
      const amounts = M.amountsForLiquidity(liquidity, sqrtLower, sqrtUpper, sqrtCurrent);
      if (state.compose.lastEdited === 'kntq') {
        state.compose.hype = ethers.formatUnits(amounts.amount0, 18).replace(/\.?0+$/, '');
        setInputValue(ui.hypeInput, state.compose.hype);
      } else {
        state.compose.kntq = ethers.formatUnits(amounts.amount1, 18).replace(/\.?0+$/, '');
        setInputValue(ui.kntqInput, state.compose.kntq);
      }
      const amount0Max = amounts.amount0 + amounts.amount0 * BigInt(slip) / 10000n + 2n;
      const amount1Max = amounts.amount1 + amounts.amount1 * BigInt(slip) / 10000n + 2n;
      if (state.wallet.address && amount0Max + gasReserve > state.balances.hype) throw new Error('HYPE 余额不足：本次最多需要 ' + fmtToken(amount0Max + gasReserve, 18, 5) + '（含滑点缓冲和 gas），钱包 ' + fmtToken(state.balances.hype, 18, 5) + '。请点“刷新余额”或减少数量。');
      if (state.wallet.address && amounts.amount1 > state.balances.kntq) throw new Error('KNTQ 余额不足：本次需要 ' + fmtToken(amounts.amount1, 18, 5) + '，钱包 ' + fmtToken(state.balances.kntq, 18, 5) + '。请点“刷新余额”或减少 HYPE 数量。');
      const kUsd = kntqUsd();
      const totalUsd = kUsd == null ? null : Number(ethers.formatUnits(amounts.amount0, 18)) * state.market.price + Number(ethers.formatUnits(amounts.amount1, 18)) * kUsd;
      state.compose.quote = {
        amount0: amounts.amount0, amount1: amounts.amount1,
        amount0Max, amount1Max, liquidity, range,
        slip, slipPct, totalUsd,
        deadline: nowSec() + 600,
        createdAt: Date.now(), price: state.pool.price, rawPrice: state.pool.rawPrice,
        fee: state.pool.lpFee
      };
      state.compose.error = null;
    } catch (error) {
      if (seq === state.compose.seq) { state.compose.quote = null; state.compose.error = decodeErr(error); }
    } finally {
      if (seq === state.compose.seq) { state.compose.quoting = false; updateComposeUi(); updateComposerButtons(); }
    }
  }

  let quoteTimer = null;
  function scheduleQuote(immediate) {
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(computeQuote, immediate ? 20 : 220);
  }

  function updatePresetUi() {
    if (!ui.rangePresets) return;
    ui.rangePresets.querySelectorAll('button[data-preset]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.preset === state.compose.preset);
    });
    if (ui.customRange) ui.customRange.hidden = state.compose.preset !== 'custom';
  }

  function updateComposeUi() {
    if (!state.config || !ui.hypeInput) return;
    updatePresetUi();
    const maxPct = Number(state.config.safety.maxSlippageBps || 300) / 100;
    ui.slippageInput.max = String(maxPct);
    ui.slippageHint.textContent = '只使用你填的百分比（上限 ' + fmtNum(maxPct, 2) + '%），失败不会自动放宽';
    if (state.pool) {
      ui.rangeCurrent.textContent = fmtPrice(state.pool.price);
      ui.poolPrice.textContent = 'KNTQ ' + (kntqUsd() == null ? '$—' : fmtUsd(kntqUsd(), { digits: 4 }));
      if (!state.compose.quote) { try { updateRangeUi(selectedRange()); } catch (_) { updateRangeUi(null); } }
    }
    const q = state.compose.quote;
    const error = state.compose.error;
    ui.composerError.hidden = !error;
    ui.composerError.textContent = error || '';
    if (q) {
      ui.quoteState.textContent = '可添加';
      ui.quoteBudget.textContent = q.totalUsd == null ? '—' : fmtUsd(q.totalUsd);
      ui.quoteHype.textContent = fmtToken(q.amount0, 18, 6);
      ui.quoteKntq.textContent = fmtToken(q.amount1, 18, 5);
      ui.quoteRatio.textContent = amountRatioText(q.amount0, q.amount1);
      ui.quoteRange.textContent = q.range.full ? '全范围' : (fmtPrice(q.range.lowerPrice) + ' – ' + fmtPrice(q.range.upperPrice));
      ui.quoteFee.textContent = fmtBps(q.fee);
      ui.quoteSlip.textContent = fmtNum(q.slipPct, 2) + '%';
      ui.quoteMin.textContent = 'HYPE ≤ ' + fmtToken(q.amount0Max, 18, 6) + ' · KNTQ ≤ ' + fmtToken(q.amount1Max, 18, 5);
      ui.quoteNote.textContent = '按当前价格和区间自动配比；签名前会重新模拟。KNTQ 不足不会自动兑换。';
      ui.amountUsd.textContent = q.totalUsd == null ? '≈ $—' : '≈ ' + fmtUsd(q.totalUsd);
      ui.amountRatio.textContent = amountRatioText(q.amount0, q.amount1);
    } else {
      ui.quoteState.textContent = state.compose.quoting ? '计算中' : (error ? '需调整' : '等待输入');
      ui.quoteBudget.textContent = '—'; ui.quoteHype.textContent = '—'; ui.quoteKntq.textContent = '—';
      ui.quoteRatio.textContent = '—'; ui.quoteRange.textContent = '—'; ui.quoteFee.textContent = '1.00%'; ui.quoteSlip.textContent = fmtNum(parseFloatSafe(ui.slippageInput.value) || 0, 2) + '%'; ui.quoteMin.textContent = '—';
      if (!error) ui.quoteNote.textContent = '输入任意一侧数量，另一侧按当前区间比例自动计算。';
      if (!state.compose.hype && !state.compose.kntq) { ui.amountUsd.textContent = '≈ $—'; ui.amountRatio.textContent = '—'; }
    }
    updateComposerButtons();
  }

  function sparkline(points) {
    if (!points || points.length < 2) return '<svg class="sparkline" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><path class="line" d="M0 20 L100 20" opacity="0.35"></path></svg>';
    const vals = points.map((p) => usdFees(BigInt(p.f0 || '0'), BigInt(p.f1 || '0')) || 0);
    const mn = Math.min(...vals); const mx = Math.max(...vals); const span = mx - mn || 1;
    const path = vals.map((v, i) => (i ? 'L' : 'M') + ((i / (vals.length - 1)) * 100).toFixed(2) + ' ' + (25 - ((v - mn) / span) * 20).toFixed(2)).join(' ');
    return '<svg class="sparkline" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><path class="line" d="' + path + '"></path></svg>';
  }

  function positionCard(p) {
    const statusClass = p.closed ? 'gray' : p.inRange ? 'green' : 'amber';
    const status = p.closed ? '已撤空仓' : p.inRange ? '在区间' : (state.pool.tick < p.tickLower ? '低于区间' : '高于区间');
    const perSec = p.perSecond;
    const perDay = perSec == null ? null : perSec * 86400;
    const stale = txBlocked();
    const k = kntqUsd();
    const rangeLower = Number.isFinite(p.rangeLower) ? p.rangeLower : 0;
    const rangeUpper = Number.isFinite(p.rangeUpper) ? p.rangeUpper : 0;
    const windowText = (key, seconds) => {
      const w = p.aprWindows?.[key];
      if (w) return fmtPct(w.apr);
      if (p.ageSec != null && p.ageSec < seconds) return '建仓中';
      return '—';
    };
    return '' +
      '<article class="position-card ' + (p.closed ? 'empty' : p.inRange ? 'in-range' : 'out-of-range') + '" data-token-id="' + p.tokenId + '">' +
        '<div class="pos-head"><div class="pos-id"><strong>#' + p.tokenId + '</strong><span class="pair">KNTQ / HYPE</span></div><span class="badge ' + statusClass + '">' + status + '</span></div>' +
        '<div class="pos-pnl">' +
          '<span>投入 ' + (p.entryValueUsd == null ? '—' : (p.entry?.estimated ? '≈' : '') + fmtUsd(p.entryValueUsd)) + '</span>' +
          '<span>当前总价值 ' + (p.currentValueUsd == null ? '—' : fmtUsd(p.currentValueUsd, { digits: 2 })) + '</span>' +
          '<b class="' + (p.pnlUsd == null ? '' : p.pnlUsd >= 0 ? 'pnl-up' : 'pnl-down') + '">PNL ' + (p.pnlUsd == null ? '—' : fmtSignedUsd(p.pnlUsd)) + (p.pnlPct == null ? '' : ' (' + (p.pnlPct >= 0 ? '+' : '') + fmtNum(p.pnlPct, 2) + '%)') + '</b>' +
          '<small>' + (p.entry ? '建仓 KNTQ ' + fmtUsd(p.entry.kntqAt, { digits: 4 }) + ' · 当前 ' + (k == null ? '$—' : fmtUsd(k, { digits: 4 })) + ' · ' : '') + (p.ilUsd == null ? '已含待领+已领' : '已含待领+已领 · IL ' + fmtSignedUsd(p.ilUsd)) + (p.claimedUsd > 0 ? ' · 已领 ' + fmtUsd(p.claimedUsd) : '') + (p.entry?.estimated ? ' · 估算' : '') + '</small>' +
        '</div>' +
        '<div class="pnl-equation">' +
          '<span>本金 <b>' + (p.principalUsd == null ? '$—' : fmtUsd(p.principalUsd)) + '</b></span><i>+</i>' +
          '<span>待领收益 <b>' + (p.feesUsd == null ? '$—' : fmtUsd(p.feesUsd, { digits: 2 })) + '</b></span><i>+</i>' +
          '<span>已领取收益 <b>' + fmtUsd(p.claimedUsd || 0, { digits: 2 }) + '</b></span><i>=</i>' +
          '<span class="eq-total">当前总价值 <b>' + (p.currentValueUsd == null ? '$—' : fmtUsd(p.currentValueUsd, { digits: 2 })) + '</b></span>' +
        '</div>' +
        '<div class="pos-metrics">' +
          '<div class="metric"><div class="metric-label"><span>本金 · 当前估值</span><span>' + (p.inRange ? 'IN RANGE' : 'OUT') + '</span></div>' +
            '<strong class="metric-value">' + (p.principalUsd == null ? '$—' : fmtUsd(p.principalUsd)) + '</strong>' +
            '<span class="metric-sub">' + fmtToken(p.amount0, 18, 6) + ' HYPE + ' + fmtToken(p.amount1, 18, 5) + ' KNTQ</span>' +
            '<div class="pos-range">区间 ' + (state.market?.price ? fmtUsd(rangeLower * state.market.price, { digits: 4 }) + ' – ' + fmtUsd(rangeUpper * state.market.price, { digits: 4 }) : '—') + ' KNTQ/USDT' + (k != null && rangeLower > 0 && rangeUpper > 0 ? ' · 距下轨 ' + fmtNum((k / (rangeLower * state.market.price) - 1) * 100, 1) + '% / 距上轨 ' + fmtNum((rangeUpper * state.market.price / k - 1) * 100, 1) + '%' : '') + '</div>' +
          '</div>' +
          '<div class="metric"><div class="metric-label"><span>待领收益</span><span class="sync">链上 fee growth</span></div>' +
            '<strong class="metric-value ' + (p.feesUsd > 0 ? 'positive' : 'muted') + '">' + (p.feesUsd == null ? '$—' : fmtUsd(p.feesUsd)) + '</strong>' +
            '<span class="metric-sub">' + fmtToken(p.fees0, 18, 6) + ' HYPE + ' + fmtToken(p.fees1, 18, 5) + ' KNTQ</span>' +
            '<div class="metric-foot"><span>领取时以链上为准</span></div>' +
          '</div>' +
          '<div class="metric"><div class="metric-label"><span>已领取收益</span><span class="sync">累计</span></div>' +
            '<strong class="metric-value ' + (p.claimedUsd > 0 ? 'positive' : 'muted') + '">' + (p.claimedUsd > 0 ? fmtUsd(p.claimedUsd) : '$0.00') + '</strong>' +
            '<span class="metric-sub">' + (p.claimedCount > 0 ? '已领 ' + p.claimedCount + ' 次' : '尚未领取') + '</span>' +
            '<div class="metric-foot"><span>计入 PNL · 100% 撤池后清除</span></div>' +
          '</div>' +
          '<div class="metric"><div class="metric-label"><span>预估年化</span><span>' + (p.aprWindow || '估算中') + '</span></div>' +
            '<strong class="metric-value ' + (p.apr > 0 ? 'positive' : 'muted') + '">' + (p.apr == null ? '—' : fmtPct(p.apr)) + '</strong>' +
            '<div class="rate-line"><b>' + (p.dayYield == null ? '+$—' : '+ ' + fmtUsd(p.dayYield, { digits: 2 })) + ' / 天</b><span>' + (perSec == null ? '' : '≈ ' + fmtTinyUsd(perSec) + ' / 秒') + '</span></div>' +
            '<div class="metric-foot"><span>5m ' + windowText('5m', 300) + ' · 30m ' + windowText('30m', 1800) + ' · 1h ' + windowText('1h', 3600) + '</span></div>' + sparkline(p.aprPoints) +
          '</div>' +
        '</div>' +
        (stale ? '<div class="card-stale">数据过期，正在自动重试；交易暂时锁定。</div>' : '') +
        '<div class="pos-footer">' +
          '<div class="pos-actions">' +
            (state.wallet.readOnly
              ? '<span class="metric-sub">只读看板 · 连接钱包后可操作</span>'
              : ((p.fees0 > 0n || p.fees1 > 0n) ? '<button class="btn small" data-action="claim" data-token-id="' + p.tokenId + '" ' + (stale ? 'disabled' : '') + '>提取手续费</button>' : '') +
                ((!p.closed && p.liquidity > 0n) ? '<button class="btn small primary" data-action="withdraw" data-token-id="' + p.tokenId + '" ' + (stale ? 'disabled' : '') + '>撤池</button>' : '') +
                (p.closed ? '<button class="btn small" data-action="burn" data-token-id="' + p.tokenId + '" ' + (stale ? 'disabled' : '') + '>销毁空 NFT</button>' : '')) +
          '</div>' +
          '<div class="pos-detail"><span>NFT #' + p.tokenId + (p.entryAgeSec == null ? '' : ' · 持仓 ' + M.formatDuration(p.entryAgeSec)) + '</span><b>2.00%</b></div>' +
        '</div>' +
      '</article>';
  }

  function sortedPositions() {
    const list = state.positions.filter((p) => !state.hideClosed || !p.closed);
    return list.sort((a, b) => {
      if (state.sort === 'fees') return (b.feesUsd || 0) - (a.feesUsd || 0);
      if (state.sort === 'apr') return (b.apr ?? -1) - (a.apr ?? -1);
      if (state.sort === 'newest') return (b.firstSeen || 0) - (a.firstSeen || 0);
      if (state.sort === 'range') { const s = (p) => p.closed ? -1 : p.inRange ? 2 : 1; return s(b) - s(a) || (b.principalUsd || 0) - (a.principalUsd || 0); }
      return (b.principalUsd || 0) - (a.principalUsd || 0);
    });
  }

  function renderPositions() {
    if (ui.cleanupEmptyBtn) {
      ui.cleanupEmptyBtn.hidden = !(state.hiddenEmpty > 0);
      ui.cleanupEmptyBtn.textContent = '清理 ' + state.hiddenEmpty + ' 个空 NFT';
    }
    if (state.loading && !state.positions.length) {
      ui.positionsGrid.innerHTML = '<div class="loading-card"></div><div class="loading-card"></div><div class="loading-card"></div>';
      ui.positionsEmpty.hidden = true;
      return;
    }
    const visible = sortedPositions();
    if (!visible.length) {
      ui.positionsGrid.innerHTML = '';
      ui.positionsEmpty.hidden = false;
      if (state.hiddenEmpty > 0 && state.hideClosed) {
        ui.positionsEmpty.querySelector('h4').textContent = '已撤空仓已隐藏';
        ui.positionsEmpty.querySelector('p').textContent = '当前地址有 ' + state.hiddenEmpty + ' 个空 NFT（Ascend 仍会显示）。可以直接销毁，销毁后 Ascend 不再列出。';
        if (ui.emptyBurnBtn) { ui.emptyBurnBtn.hidden = false; ui.emptyBurnBtn.textContent = '销毁 ' + state.hiddenEmpty + ' 个空 NFT'; }
      } else {
        if (ui.emptyBurnBtn) ui.emptyBurnBtn.hidden = true;
        ui.positionsEmpty.querySelector('h4').textContent = '还没有 KNTQ/HYPE 仓位';
        ui.positionsEmpty.querySelector('p').textContent = state.wallet.address ? '右侧输入 HYPE 和 KNTQ 数量，先预览再创建仓位。' : '连接钱包后，这里会显示真实 V4 NFT 仓位、可领取手续费与近期实测年化。';
      }
      return;
    }
    ui.positionsEmpty.hidden = true;
    if (ui.emptyBurnBtn) ui.emptyBurnBtn.hidden = true;
    const groups = new Map();
    for (const p of visible.filter((x) => !x.closed)) {
      const key = p.tickLower + ':' + p.tickUpper;
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    const dup = Array.from(groups.entries()).find(([, n]) => n > 1);
    if (dup) {
      const sample = visible.find((x) => x.tickLower + ':' + x.tickUpper === dup[0]);
      ui.rangeNotice.hidden = false;
      ui.rangeNotice.textContent = '检测到 ' + dup[1] + ' 个仓位使用同一区间（' + (state.market?.price ? fmtUsd(sample.rangeLower * state.market.price, { digits: 4 }) + ' – ' + fmtUsd(sample.rangeUpper * state.market.price, { digits: 4 }) + ' USDT' : '') + '）。同区间同流动性效率，年化会接近。';
    } else { ui.rangeNotice.hidden = true; }
    ui.positionsGrid.innerHTML = visible.map(positionCard).join('');
  }

  function updateSummary() {
    const active = state.positions.filter((p) => !p.closed);
    const totalPrincipal = active.reduce((s, p) => s + (p.principalUsd || 0), 0);
    const totalFees = state.positions.reduce((s, p) => s + (p.feesUsd || 0), 0);
    const weightedFor = (key) => active.reduce((acc, p) => {
      const w = key ? p.aprWindows?.[key] : null;
      const apr = key ? w?.apr : p.apr;
      if (apr == null || p.principalUsd == null) return acc;
      acc.weight += p.principalUsd; acc.value += p.principalUsd * apr; return acc;
    }, { weight: 0, value: 0 });
    const weighted = weightedFor(null);
    const hour = weightedFor('1h');
    const five = weightedFor('5m');
    const thirty = weightedFor('30m');
    const day = active.reduce((sum, p) => sum + (p.dayYield || 0), 0);
    const a0 = state.positions.reduce((s, p) => s + p.amount0, 0n);
    const a1 = state.positions.reduce((s, p) => s + p.amount1, 0n);
    ui.sumPrincipal.textContent = state.market ? fmtUsd(totalPrincipal) : '$—';
    ui.sumPrincipalTokens.textContent = fmtToken(a0, 18, 5) + ' HYPE + ' + fmtToken(a1, 18, 4) + ' KNTQ';
    ui.sumFees.textContent = state.market ? fmtUsd(totalFees) : '$—';
    ui.sumFeesTokens.textContent = state.positions.length ? '链上 fee growth · ' + state.positions.length + ' 个仓位' : '—';
    ui.sumApr.textContent = weighted.weight > 0 ? fmtPct(weighted.value / weighted.weight) : (hour.weight > 0 ? fmtPct(hour.value / hour.weight) : '—');
    ui.sumApr.className = weighted.weight > 0 ? 'gain' : '';
    ui.hourApr.textContent = hour.weight > 0 ? fmtPct(hour.value / hour.weight) : (thirty.weight > 0 ? fmtPct(thirty.value / thirty.weight) + '（30m）' : (five.weight > 0 ? fmtPct(five.value / five.weight) + '（5m）' : (weighted.weight > 0 ? fmtPct(weighted.value / weighted.weight) : '—')));
    ui.dayYield.textContent = day > 0 ? '+ ' + fmtUsd(day, { digits: 2 }) : '$—';
    ui.shortApr.textContent = (five.weight > 0 ? fmtPct(five.value / five.weight) : '—') + ' / ' + (thirty.weight > 0 ? fmtPct(thirty.value / thirty.weight) : '—');
    ui.sumPositions.textContent = String(active.length);
    ui.sumEmpty.textContent = state.hiddenEmpty + ' 个已撤空仓 · 默认' + (state.hideClosed ? '隐藏' : '显示');
    const withEntry = active.filter((p) => p.entryValueUsd != null);
    const totalEntry = withEntry.reduce((sum, p) => sum + p.entryValueUsd, 0);
    const claimedTotal = Object.values(state.claims || {}).reduce((sum, row) => sum + Number(row.usd || 0), 0);
    const claimedInActive = active.reduce((sum, p) => sum + (p.claimedUsd || 0), 0);
    const unallocatedClaimed = Math.max(0, claimedTotal - claimedInActive);
    const totalCurrent = active.reduce((sum, p) => sum + (p.currentValueUsd || p.principalUsd || 0), 0) + unallocatedClaimed;
    const totalPnl = withEntry.length ? withEntry.reduce((sum, p) => sum + (p.pnlUsd || 0), 0) + unallocatedClaimed : (unallocatedClaimed > 0 ? unallocatedClaimed : null);
    ui.totalEntry.textContent = withEntry.length ? fmtUsd(totalEntry) : '$—';
    ui.totalCurrent.textContent = active.length || unallocatedClaimed > 0 ? fmtUsd(totalCurrent, { digits: 2 }) : '$—';
    ui.totalPnl.textContent = totalPnl == null ? '—' : fmtSignedUsd(totalPnl);
    ui.totalPnl.className = totalPnl == null ? '' : totalPnl >= 0 ? 'gain' : 'loss';
    ui.totalPnlPct.textContent = totalPnl == null || !(totalEntry > 0) ? '本金+待领+已领-投入' : (totalPnl >= 0 ? '+' : '') + fmtNum(totalPnl / totalEntry * 100, 2) + '% · 已含待领/已领';
  }

  const CHART_TF = {
    '1m': { seconds: 60, candles: 20 },
    '5m': { seconds: 300, candles: 24 },
    '15m': { seconds: 900, candles: 16 },
    '1h': { seconds: 3600, candles: 8 }
  };

  function chartLookback(tf) {
    const c = CHART_TF[tf] || CHART_TF['5m'];
    return Math.min(c.seconds * c.candles, 8 * 3600);
  }

  function parseSwapLog(log, currentBlock, secPerBlock) {
    try {
      const data = log.data.slice(2);
      const words = [];
      for (let i = 0; i < data.length; i += 64) words.push(data.slice(i, i + 64));
      if (words.length < 5) return null;
      const sqrt = BigInt('0x' + words[2]);
      const tick = int24(BigInt('0x' + words[4]));
      const rawness = (Number(sqrt) / 2 ** 96) ** 2;
      if (!(rawness > 0)) return null;
      let ts = Number(log.blockTimestamp || 0);
      if (!Number.isFinite(ts) || ts <= 0) ts = Math.floor(Date.now() / 1000) - (currentBlock - Number(BigInt(log.blockNumber))) * secPerBlock;
      return { ts, raw: rawness, inv: 1 / rawness, tick, liquidity: BigInt('0x' + words[3]), block: Number(BigInt(log.blockNumber)) };
    } catch (_) { return null; }
  }

  function candleFromSwaps(swaps, interval, invert) {
    const map = new Map();
    for (const s of swaps) {
      const bucket = Math.floor(s.ts / interval) * interval;
      const price = invert ? s.raw : s.inv;
      if (!(price > 0)) continue;
      if (!map.has(bucket)) map.set(bucket, { t: bucket, o: price, h: price, l: price, c: price, n: 1 });
      else { const c = map.get(bucket); c.h = Math.max(c.h, price); c.l = Math.min(c.l, price); c.c = price; c.n += 1; }
    }
    return Array.from(map.values()).sort((a, b) => a.t - b.t);
  }

  let chartTimer = null;
  function scheduleChart() {
    clearTimeout(chartTimer);
    chartTimer = setTimeout(() => { loadChart().catch(() => {}); }, 1800);
  }
  let distributionTimer = null;
  function scheduleDistribution() {
    clearTimeout(distributionTimer);
    distributionTimer = setTimeout(() => { loadDistribution().catch(() => {}); }, 3600);
  }

  async function loadChart() {
    if (!state.config || !state.pool || !ui.priceChart) return;
    const tf = state.chart.tf;
    const key = tf + ':' + (state.chart.invert ? 'raw' : 'ui');
    const cached = state.chart.cache[key];
    if (cached && Date.now() - cached.at < 300000) { state.chart.candles = cached.candles; state.chart.stats = cached.stats; drawChart(); return; }
    state.chart.loading = true;
    const seq = ++state.chart.seq;
    ui.chartEmpty.textContent = '读取成交中…'; ui.chartEmpty.hidden = false;
    try {
      const secPerBlock = state.block && state.pool ? await estimateBlockSeconds(state.block) : Number(state.config.safety.blockTimeSeconds || 0.18);
      const lookback = chartLookback(tf);
      const currentBlock = state.block?.number || 0;
      const fromBlock = Math.max(Number(state.config.uniswap.deploymentBlock), currentBlock - Math.ceil(lookback / Math.max(0.02, secPerBlock)));
      const logs = await getLogsChunked({
        address: getAddress(state.config.uniswap.poolManager),
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: 'latest',
        topics: [SWAP_TOPIC, state.config.uniswap.poolId]
      }, 10000);
      if (seq !== state.chart.seq) return;
      const swaps = (logs || []).map((l) => parseSwapLog(l, currentBlock, secPerBlock)).filter(Boolean).slice(-8000);
      if (!swaps.length) {
        state.chart.candles = []; state.chart.stats = null; state.chart.cache[key] = { at: Date.now(), candles: [], stats: null };
        ui.chartEmpty.textContent = '暂无成交'; ui.chartEmpty.hidden = false; updateChartFoot(); return;
      }
      const candles = candleFromSwaps(swaps, CHART_TF[tf].seconds, state.chart.invert);
      const stats = { count: swaps.length, first: candles[0]?.t || 0, last: candles[candles.length - 1]?.c || 0 };
      state.chart.candles = candles; state.chart.stats = stats;
      state.chart.cache[key] = { at: Date.now(), candles, stats };
      ui.chartEmpty.hidden = candles.length > 0;
      drawChart(); updateChartFoot();
    } catch (error) {
      if (seq === state.chart.seq) {
        ui.chartEmpty.textContent = 'K线读取失败，自动重试中';
        ui.chartEmpty.hidden = false;
        clearTimeout(state.chart.retryTimer);
        state.chart.retryTimer = setTimeout(() => { loadChart().catch(() => {}); }, 15000);
      }
    } finally {
      if (seq === state.chart.seq) state.chart.loading = false;
    }
  }

  function updateChartFoot() {
    const c = state.chart.candles || [];
    if (!c.length) { ui.chartLast.textContent = '—'; ui.chartStats.textContent = '—'; return; }
    const last = c[c.length - 1];
    const stats = state.chart.stats || {};
    ui.chartLast.textContent = '最新 ' + fmtPrice(last.c) + (state.chart.invert ? ' KNTQ/HYPE' : ' HYPE/KNTQ');
    ui.chartStats.textContent = (stats.count || 0) + ' 笔成交 · ' + new Date(last.t * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function drawChart() {
    const canvas = ui.priceChart;
    if (!canvas) return;
    const parent = canvas.parentElement;
    const rect = parent.getBoundingClientRect();
    const width = Math.max(280, Math.floor(rect.width));
    const height = Math.max(160, Math.floor(rect.height || 210));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr); canvas.height = Math.floor(height * dpr);
    canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const candles = state.chart.candles || [];
    if (!candles.length) return;
    const pad = { l: 8, r: 62, t: 10, b: 18 };
    const plotW = width - pad.l - pad.r, plotH = height - pad.t - pad.b;
    let lo = Infinity, hi = -Infinity;
    for (const c of candles) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); }
    if (!(hi > lo)) { hi = lo * 1.01; lo *= 0.99; }
    const span = hi - lo || 1; const y = (v) => pad.t + (hi - v) / span * plotH;
    ctx.strokeStyle = '#eeede7'; ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i += 1) { const yy = pad.t + (plotH / 3) * i; ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(pad.l + plotW, yy); ctx.stroke(); }
    const slot = plotW / Math.max(1, candles.length);
    const bodyW = Math.max(1, Math.min(7, slot * 0.62));
    for (let i = 0; i < candles.length; i += 1) {
      const c = candles[i]; const x = pad.l + slot * i + slot / 2;
      const up = c.c >= c.o;
      ctx.strokeStyle = up ? '#0f7a4a' : '#b3261e';
      ctx.fillStyle = up ? '#0f7a4a' : '#b3261e';
      ctx.beginPath(); ctx.moveTo(x, y(c.h)); ctx.lineTo(x, y(c.l)); ctx.stroke();
      const top = Math.min(y(c.o), y(c.c)); const bh = Math.max(1, Math.abs(y(c.o) - y(c.c)));
      ctx.fillRect(x - bodyW / 2, top, bodyW, bh);
    }
    const last = candles[candles.length - 1];
    const ly = y(last.c);
    ctx.setLineDash([3, 3]); ctx.strokeStyle = '#b4530a'; ctx.beginPath(); ctx.moveTo(pad.l, ly); ctx.lineTo(pad.l + plotW, ly); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#77776d'; ctx.font = '10px ' + getComputedStyle(document.body).fontFamily;
    ctx.fillText(fmtPrice(hi), pad.l + plotW + 6, pad.t + 4);
    ctx.fillText(fmtPrice(lo), pad.l + plotW + 6, pad.t + plotH);
    ctx.fillText(fmtPrice(last.c), pad.l + plotW + 6, ly + 3);
    ctx.fillText(new Date(candles[0].t * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), pad.l, height - 3);
    ctx.fillText(new Date(last.t * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), pad.l + plotW - 34, height - 3);
  }

  async function loadDistribution() {
    if (!state.config || !state.pool || !ui.liquidityBars) return;
    if (state.distribution.loading) return;
    if (Date.now() - state.distribution.at < 300000) return;
    state.distribution.loading = true;
    try {
      const stateView = getAddress(state.config.uniswap.stateView);
      const poolId = state.config.uniswap.poolId;
      const spacing = Number(state.config.uniswap.tickSpacing || 200);
      const compressed = Math.floor(state.pool.tick / spacing);
      const word = Math.floor(compressed / 256);
      const words = [];
      for (let w = word - 2; w <= word + 2; w += 1) words.push(w);
      const bitRes = await batchCalls(words.map((w) => ({ to: stateView, data: callData(iface.state, 'getTickBitmap', [poolId, w]) })));
      const tickList = [];
      for (let i = 0; i < words.length; i += 1) {
        if (bitRes[i].error) continue;
        const bitmap = BigInt(bitRes[i].result);
        for (let bit = 0; bit < 256; bit += 1) {
          if ((bitmap >> BigInt(bit)) & 1n) tickList.push((words[i] * 256 + bit) * spacing);
        }
      }
      const unique = [...new Set(tickList)].filter((t) => t >= M.MIN_TICK && t <= M.MAX_TICK).sort((a, b) => a - b);
      if (!unique.length) {
        ui.liquidityBars.innerHTML = '<div class="dist-empty">当前价格附近没有已初始化区间</div>';
        if (ui.liquidityTable) ui.liquidityTable.innerHTML = '';
        return;
      }
      const liqRes = await batchCalls(unique.map((t) => ({ to: stateView, data: callData(iface.state, 'getTickLiquidity', [poolId, t]) })));
      const points = [];
      for (let i = 0; i < unique.length; i += 1) {
        if (liqRes[i].error) continue;
        const d = iface.state.decodeFunctionResult('getTickLiquidity', liqRes[i].result);
        points.push({ tick: unique[i], gross: d[0], net: d[1] });
      }
      const above = points.filter((p) => p.tick > state.pool.tick).sort((a, b) => a.tick - b.tick);
      const below = points.filter((p) => p.tick <= state.pool.tick).sort((a, b) => b.tick - a.tick);
      let L = state.pool.liquidity;
      const rows = [];
      let prev = state.pool.tick;
      for (const p of above) {
        if (L > 0n && p.tick > prev) rows.push({ lower: prev, upper: p.tick, L });
        L += p.net;
        prev = p.tick;
      }
      if (L > 0n) rows.push({ lower: prev, upper: Math.max(prev + spacing, state.pool.tick + spacing * 4), L });
      L = state.pool.liquidity;
      prev = state.pool.tick;
      for (const p of below) {
        if (L > 0n && p.tick < prev) rows.push({ lower: p.tick, upper: prev, L });
        L -= p.net;
        prev = p.tick;
      }
      if (!rows.length) {
        ui.liquidityBars.innerHTML = '<div class="dist-empty">当前没有有效流动性</div>';
        if (ui.liquidityTable) ui.liquidityTable.innerHTML = '';
        return;
      }
      const hypeUsd = state.market?.price;
      const currentUsd = kntqUsd();
      if (!(hypeUsd > 0) || !(currentUsd > 0)) {
        ui.liquidityBars.innerHTML = '<div class="dist-empty">等待 HYPE 行情以换算 USDT</div>';
        if (ui.liquidityTable) ui.liquidityTable.innerHTML = '';
        return;
      }
      const priceRow = (r) => {
        const rawLo = M.priceFromSqrtX96(M.tickToSqrtRatioX96(r.lower));
        const rawHi = M.priceFromSqrtX96(M.tickToSqrtRatioX96(r.upper));
        return { lo: rawHi > 0 ? (1 / rawHi) * hypeUsd : 0, hi: rawLo > 0 ? (1 / rawLo) * hypeUsd : 0 };
      };
      const visibleRows = rows.filter((r) => {
        const pr = priceRow(r);
        return pr.hi >= currentUsd * 0.7 && pr.lo <= currentUsd * 1.3;
      });
      if (!visibleRows.length) {
        ui.liquidityBars.innerHTML = '<div class="dist-empty">当前价格附近没有有效区间</div>';
        if (ui.liquidityTable) ui.liquidityTable.innerHTML = '';
        return;
      }
      const total = visibleRows.reduce((sum, r) => sum + r.L, 0n);
      const maxL = visibleRows.reduce((m, r) => (r.L > m ? r.L : m), 0n);
      const main = visibleRows.slice().sort((a, b) => (b.L > a.L ? 1 : b.L < a.L ? -1 : 0))[0];
      const bars = visibleRows.map((r) => ({ row: r, pr: priceRow(r) })).sort((a, b) => a.pr.lo - b.pr.lo);
      const maxShare = maxL > 0n ? Number((maxL * 10000n) / total) / 100 : 1;
      ui.liquidityBars.innerHTML = bars.map((item) => {
        const r = item.row; const pr = item.pr;
        const share = total > 0n ? Number((r.L * 10000n) / total) / 100 : 0;
        const height = Math.max(10, Math.sqrt(share / Math.max(maxShare, 0.01)) * 100);
        const current = state.pool.tick >= r.lower && state.pool.tick < r.upper;
        const tip = fmtUsd(pr.lo, { digits: 4 }) + '–' + fmtUsd(pr.hi, { digits: 4 }) + ' KNTQ/USDT · ' + fmtNum(share, 1) + '%';
        return '<div class="dist-column' + (current ? ' current' : '') + '" title="' + tip + '"><i style="height:' + height.toFixed(1) + '%"></i></div>';
      }).join('');
      const axisIdx = [0, Math.floor((bars.length - 1) / 4), Math.floor((bars.length - 1) / 2), Math.floor((bars.length - 1) * 3 / 4), bars.length - 1];
      if (ui.distributionAxis) {
        ui.distributionAxis.innerHTML = axisIdx.map((i) => '<span>' + (bars[i] ? fmtUsd(bars[i].pr.lo, { digits: 4 }) : '—') + '</span>').join('');
      }
      if (ui.liquidityTable) {
        const tableRows = bars.slice().sort((a, b) => (b.row.L > a.row.L ? 1 : b.row.L < a.row.L ? -1 : 0)).slice(0, 6);
        ui.liquidityTable.innerHTML = '<div class="liq-table-head"><span>主要价格区间</span><span>占比</span><span>流动性</span></div>' + tableRows.map((item) => {
          const share = total > 0n ? Number((item.row.L * 10000n) / total) / 100 : 0;
          return '<div class="liq-table-row"><span>' + fmtUsd(item.pr.lo, { digits: 4 }) + ' – ' + fmtUsd(item.pr.hi, { digits: 4 }) + '</span><b>' + fmtNum(share, 1) + '%</b><em>' + Number(item.row.L).toExponential(1) + '</em></div>';
        }).join('');
      }
      ui.distCurrentPrice.textContent = fmtUsd(currentUsd, { digits: 4 });
      ui.distAltPrice.textContent = '1 USDT = ' + fmtNum(1 / currentUsd, 2) + ' KNTQ';
      ui.distStatPrice.textContent = fmtUsd(currentUsd, { digits: 4 });
      ui.distHypePrice.textContent = fmtUsd(hypeUsd, { digits: 2 });
      ui.distActiveLiquidity.textContent = maxL > 0n ? Number(maxL).toExponential(2).replace('e+', 'e') : '—';
      const mpr = priceRow(main);
      ui.distMainRange.textContent = fmtUsd(mpr.lo, { digits: 4 }) + ' – ' + fmtUsd(mpr.hi, { digits: 4 });
      ui.distMainShare.textContent = fmtNum(maxShare, 1) + '%';
      ui.distCount.textContent = bars.length + ' 个区间';
      state.distribution.at = Date.now();
    } catch (_) {
      ui.liquidityBars.innerHTML = '<div class="dist-empty">分布读取失败，自动重试中</div>';
    } finally { state.distribution.loading = false; }
  }

  async function readAllowances(amount1Max) {
    const owner = state.wallet.address;
    if (!owner) return { tokenToPermit2: 0n, permitAmount: 0n, permitExpiration: 0n };
    const token = getAddress(state.config.tokens.KNTQ.address);
    const permit2 = getAddress(state.config.uniswap.permit2);
    const pm = getAddress(state.config.uniswap.positionManager);
    const res = await batchCalls([
      { to: token, data: callData(iface.erc20, 'allowance', [owner, permit2]) },
      { to: permit2, data: callData(iface.permit2, 'allowance', [owner, token, pm]) }
    ]);
    const allowance = decodeCall(iface.erc20, 'allowance', res[0])[0];
    const permit = decodeCall(iface.permit2, 'allowance', res[1]);
    return { tokenToPermit2: allowance, permitAmount: permit[0], permitExpiration: permit[1] };
  }

  function encodeActionsParams(actions, params) {
    const actionBytes = ethers.hexlify(Uint8Array.from(actions));
    return coder.encode(['bytes', 'bytes[]'], [actionBytes, params]);
  }

  function buildMintData(quote) {
    const cfg = state.config;
    const key = [cfg.uniswap.poolKey.currency0, cfg.uniswap.poolKey.currency1, cfg.uniswap.poolKey.fee, cfg.uniswap.poolKey.tickSpacing, cfg.uniswap.poolKey.hooks];
    const mintParams = coder.encode(
      ['tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)', 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes'],
      [key, quote.range.lowerTick, quote.range.upperTick, quote.liquidity, quote.amount0Max, quote.amount1Max, state.wallet.address, '0x']
    );
    const settleParams = coder.encode(['address', 'address'], [key[0], key[1]]);
    const sweepParams = coder.encode(['address', 'address'], [key[0], MSG_SENDER]);
    const unlock = encodeActionsParams([2, 13, 20], [mintParams, settleParams, sweepParams]);
    return iface.pm.encodeFunctionData('modifyLiquidities', [unlock, quote.deadline]);
  }

  function buildCollectData(tokenId, liquidity, amount0Min, amount1Min, deadline) {
    const cfg = state.config;
    const decrease = coder.encode(['uint256', 'uint256', 'uint128', 'uint128', 'bytes'], [tokenId, liquidity, amount0Min, amount1Min, '0x']);
    const take = coder.encode(['address', 'address', 'address'], [cfg.uniswap.poolKey.currency0, cfg.uniswap.poolKey.currency1, state.wallet.address]);
    const unlock = encodeActionsParams([1, 17], [decrease, take]);
    return iface.pm.encodeFunctionData('modifyLiquidities', [unlock, deadline]);
  }

  function buildBurnData(tokenId, amount0Min, amount1Min, deadline) {
    const cfg = state.config;
    // BURN_POSITION = action 0x03: clears all liquidity, takes both currencies and burns the NFT.
    const burn = coder.encode(['uint256', 'uint128', 'uint128', 'bytes'], [tokenId, amount0Min, amount1Min, '0x']);
    const take = coder.encode(['address', 'address', 'address'], [cfg.uniswap.poolKey.currency0, cfg.uniswap.poolKey.currency1, state.wallet.address]);
    const unlock = encodeActionsParams([3, 17], [burn, take]);
    return iface.pm.encodeFunctionData('modifyLiquidities', [unlock, deadline]);
  }

  function buildBurnManyData(positions) {
    const cfg = state.config;
    const actions = [];
    const params = [];
    for (const p of positions) {
      actions.push(3, 17);
      params.push(coder.encode(['uint256', 'uint128', 'uint128', 'bytes'], [p.tokenId, 0n, 0n, '0x']));
      params.push(coder.encode(['address', 'address', 'address'], [cfg.uniswap.poolKey.currency0, cfg.uniswap.poolKey.currency1, state.wallet.address]));
    }
    const unlock = encodeActionsParams(actions, params);
    return iface.pm.encodeFunctionData('modifyLiquidities', [unlock, nowSec() + 600]);
  }

  function openBurnAllEmpty() {
    const closed = state.positions.filter((p) => p.closed && p.liquidity === 0n);
    if (!closed.length) { toast('没有可销毁的空 NFT', '当前没有空仓。'); return; }
    if (txBlocked()) { toast('数据过期', '刷新后再销毁。', 'error'); return; }
    const data = buildBurnManyData(closed);
    const step = { id: 'burn-all', label: '销毁空 NFT × ' + closed.length, detail: closed.map((p) => '#' + p.tokenId).join('、'), to: getAddress(state.config.uniswap.positionManager), data, value: 0n };
    openModal({
      eyebrow: 'BURN EMPTY NFTS', title: '销毁 ' + closed.length + ' 个空仓 NFT',
      body: '<div class="warning-box">这些 NFT 已经没有流动性，但 Ascend 仍会把它们列出来。BURN_POSITION 会销毁全部 NFT，之后 Ascend 不再显示。</div><div class="preview-section"><h4>执行步骤</h4><div class="preview-list">' + planStepHtml(step, 0) + '</div></div>',
      confirmText: '模拟并销毁 ' + closed.length + ' 个',
      onConfirm: async () => {
        await executeSteps([step], (s, i, phase) => {
          if (phase === 'simulating') setStepState('burn-all', '模拟中…', 'pending');
          if (phase === 'signing') setStepState('burn-all', '模拟通过 · 请在钱包确认', 'pending');
          if (phase === 'sent') setStepState('burn-all', '已发送，等待确认', 'pending');
          if (phase === 'confirmed') setStepState('burn-all', '已确认', '');
        });
        for (const p of closed) await clearClaim(p.tokenId);
        toast('空 NFT 已销毁', 'Ascend 不会再列出这些仓位。', 'success');
        closeModal(true); await refreshAll();
      }
    });
  }

  function buildMintSteps(quote) {
    const cfg = state.config;
    const token = getAddress(cfg.tokens.KNTQ.address);
    const permit2 = getAddress(cfg.uniswap.permit2);
    const pm = getAddress(cfg.uniswap.positionManager);
    const steps = [];
    if (quote.amount1Max > 0n) {
      steps.push({ id: 'approve-token', label: '授权 KNTQ → Permit2', detail: '仅授权本次上限 ' + fmtToken(quote.amount1Max, 18, 5) + ' KNTQ', to: token, data: callData(iface.erc20, 'approve', [permit2, quote.amount1Max]), value: 0n, kind: 'approve' });
      steps.push({ id: 'approve-permit2', label: 'Permit2 授权 PositionManager', detail: '仅授权本次上限，不无限授权', to: permit2, data: callData(iface.permit2, 'approve', [token, pm, quote.amount1Max, MAX_UINT48]), value: 0n, kind: 'approve' });
    }
    steps.push({ id: 'mint', label: '创建 Uniswap V4 仓位', detail: fmtToken(quote.amount0, 18, 6) + ' HYPE + ' + fmtToken(quote.amount1, 18, 5) + ' KNTQ · ' + (quote.range.full ? '全范围' : fmtPrice(quote.range.lowerPrice) + '–' + fmtPrice(quote.range.upperPrice)), to: pm, data: buildMintData(quote), value: quote.amount0Max, kind: 'mint' });
    return steps;
  }

  function planStepHtml(step, index) {
    return '<div class="preview-step pending" data-step-id="' + step.id + '"><span class="step-index">' + (index + 1) + '</span><div><strong>' + escapeHtml(step.label) + '</strong><small>' + escapeHtml(step.detail) + '</small></div><span class="step-state">待签名前模拟</span></div>';
  }

  function setStepState(id, text, cls) {
    const node = ui.modalBody.querySelector('[data-step-id="' + id + '"]');
    if (!node) return;
    node.classList.remove('pending', 'failed');
    if (cls) node.classList.add(cls);
    const s = node.querySelector('.step-state');
    if (s) s.textContent = text;
  }

  async function simulateStep(step) {
    const opts = { from: state.wallet.address };
    if (step.value && step.value > 0n) opts.value = step.value;
    await ethCall(step.to, step.data, opts);
    return estimateGas(step.to, step.data, opts);
  }

  function waitForReceipt(tx) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; const e = new Error('等待确认超时。交易已发送，不会自动重发；请在区块浏览器确认。'); e.txHash = tx.hash; reject(e); } }, 120000);
      tx.wait(1).then((r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } }).catch((e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    });
  }

  async function assertLiveWalletChain() {
    if (!state.wallet.provider) throw new Error('钱包未连接');
    const hex = await state.wallet.provider.send('eth_chainId', []);
    const live = Number(BigInt(hex));
    if (live !== Number(state.config.network.chainId)) {
      state.wallet.chainId = live;
      updateWalletUi();
      throw new Error('钱包当前网络不是 Elysium 99901，已停止签名；请切换网络后重试');
    }
  }

  async function executeSteps(steps, onProgress) {
    if (!state.wallet.signer || !state.wallet.address) throw new Error('钱包未连接');
    if (state.wallet.chainId !== Number(state.config.network.chainId)) throw new Error('钱包网络不正确');
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      if (txBlocked()) throw new Error('链上数据已过期，请刷新后重新预览');
      await assertLiveWalletChain();
      if (onProgress) onProgress(step, i, 'simulating');
      await simulateStep(step);
      if (onProgress) onProgress(step, i, 'signing');
      const tx = await state.wallet.signer.sendTransaction({ to: step.to, data: step.data, value: step.value || 0n });
      if (onProgress) onProgress(step, i, 'sent', tx.hash);
      const receipt = await waitForReceipt(tx);
      if (Number(receipt.status) !== 1) throw new Error('交易执行失败（receipt status != 1）');
      if (onProgress) onProgress(step, i, 'confirmed', tx.hash);
    }
  }

  async function previewBuild() {
    if (!state.wallet.address) { await connectWallet(); return; }
    if (state.wallet.chainId !== Number(state.config.network.chainId)) {
      try { await ensureWalletChain(true); await setupProvider(); updateWalletUi(); await refreshAll(); } catch (e) { toast('网络切换失败', decodeErr(e), 'error'); return; }
    }
    try { state.pool = await readPool(); } catch (error) { toast('池子刷新失败', decodeErr(error), 'error'); }
    try { await refreshBalances(); } catch (error) { toast('余额读取失败', decodeErr(error), 'error'); }
    await computeQuote();
    const q = state.compose.quote;
    if (!q || state.compose.error) { toast('无法生成预览', state.compose.error || '请检查数量、余额与区间。', 'error'); return; }
    let steps = buildMintSteps(q);
    // Drop approvals that are already sufficient.
    try {
      const a = await readAllowances(q.amount1Max);
      steps = steps.filter((s) => {
        if (s.id === 'approve-token') return a.tokenToPermit2 < q.amount1Max;
        if (s.id === 'approve-permit2') return a.permitAmount < q.amount1Max || Number(a.permitExpiration) < nowSec() + 3600;
        return true;
      });
    } catch (_) { /* keep approvals; per-step simulation fails closed */ }
    const body = '<div class="preview-grid">' +
      '<div class="preview-item"><span>总价值</span><strong>' + (q.totalUsd == null ? '—' : fmtUsd(q.totalUsd)) + '</strong></div>' +
      '<div class="preview-item"><span>区间</span><strong>' + (q.range.full ? '全范围' : fmtPrice(q.range.lowerPrice) + ' – ' + fmtPrice(q.range.upperPrice)) + '</strong></div>' +
      '<div class="preview-item"><span>原生 HYPE 入池</span><strong>' + fmtToken(q.amount0, 18, 6) + '</strong></div>' +
      '<div class="preview-item"><span>KNTQ 入池</span><strong>' + fmtToken(q.amount1, 18, 5) + '</strong></div>' +
      '<div class="preview-item"><span>数量上限（滑点）</span><strong>' + fmtToken(q.amount0Max, 18, 6) + ' HYPE / ' + fmtToken(q.amount1Max, 18, 5) + ' KNTQ</strong></div>' +
      '<div class="preview-item"><span>LP fee</span><strong class="gain">1.00%</strong></div>' +
    '</div>' +
    '<div class="warning-box">V4 使用原生 HYPE；多余 HYPE 会通过 SWEEP 退回。KNTQ 通过 Permit2 结算，授权仅限本次上限。每笔交易在钱包弹窗前都会重新模拟。</div>' +
    '<div class="preview-section"><h4>执行步骤</h4><div class="preview-list">' + steps.map(planStepHtml).join('') + '</div></div>' +
    '<div class="warning-box">不自动提高滑点、不自动重发。计划 90 秒后失效。</div>';
    openModal({
      eyebrow: 'V4 BUILD PLAN', title: '建仓预检', body, confirmText: '开始逐步执行',
      onConfirm: async () => executeBuildPlan({ quote: q, steps, createdAt: Date.now() })
    });
    for (const step of steps) {
      if (step.kind !== 'approve') continue;
      try { await simulateStep(step); setStepState(step.id, '模拟通过', ''); }
      catch (e) { setStepState(step.id, '预检失败：' + decodeErr(e), 'failed'); }
    }
  }

  async function executeBuildPlan(plan) {
    const q = plan.quote;
    if (Date.now() - plan.createdAt > Number(state.config.safety.txPlanTtlSeconds || 90) * 1000) throw new Error('预览已过期，请重新预览');
    const latestPool = await readPool();
    const moved = Math.abs(latestPool.rawPrice / q.rawPrice - 1) * 10000;
    if (moved > q.slip) throw new Error('池价已移动 ' + fmtBps(moved) + '，超过你的滑点 ' + fmtNum(q.slipPct, 2) + '%；请重新预览');
    try {
      await executeSteps(plan.steps, (step, i, phase, hash) => {
        if (phase === 'simulating') setStepState(step.id, '模拟中…', 'pending');
        if (phase === 'signing') setStepState(step.id, '模拟通过 · 请在钱包确认', 'pending');
        if (phase === 'sent') setStepState(step.id, '已发送 ' + (hash ? hash.slice(0, 10) + '…' : ''), 'pending');
        if (phase === 'confirmed') setStepState(step.id, '已确认', '');
      });
    } catch (e) { await refreshAll().catch(() => {}); throw e; }
    toast('建仓完成', '已刷新 Elysium 链上持仓。', 'success');
    if (state.wallet.address) { delete state.positionIds[state.wallet.address.toLowerCase()]; saveJson(STORAGE_PREFIX + 'position-ids', state.positionIds); }
    closeModal(true);
    await refreshAll();
  }

  async function openClaim(position) {
    if (txBlocked()) { toast('数据过期', '刷新后再领取。', 'error'); return; }
    const deadline = nowSec() + 600;
    const data = buildCollectData(position.tokenId, 0n, 0n, 0n, deadline);
    const step = { id: 'claim', label: '领取手续费', detail: fmtToken(position.fees0, 18, 6) + ' HYPE + ' + fmtToken(position.fees1, 18, 5) + ' KNTQ', to: getAddress(state.config.uniswap.positionManager), data, value: 0n };
    openModal({
      eyebrow: 'CLAIM FEES', title: '领取手续费 · NFT #' + position.tokenId,
      body: '<div class="preview-grid"><div class="preview-item"><span>HYPE</span><strong>' + fmtToken(position.fees0, 18, 6) + '</strong></div><div class="preview-item"><span>KNTQ</span><strong>' + fmtToken(position.fees1, 18, 5) + '</strong></div><div class="preview-item"><span>估值</span><strong>' + fmtUsd(position.feesUsd) + '</strong></div><div class="preview-item"><span>接收地址</span><strong>' + shortAddress(state.wallet.address) + '</strong></div></div><div class="warning-box">DECREASE_LIQUIDITY(0) + TAKE_PAIR，只领取手续费，不动本金。领取金额以执行时链上 fee growth 为准。</div><div class="preview-section"><h4>执行步骤</h4><div class="preview-list">' + planStepHtml(step, 0) + '</div></div>',
      confirmText: '模拟并领取',
      onConfirm: async () => {
        let txHash = null;
        await executeSteps([step], (s, i, phase, hash) => {
          if (hash) txHash = hash;
          if (phase === 'simulating') setStepState('claim', '模拟中…', 'pending');
          if (phase === 'signing') setStepState('claim', '模拟通过 · 请在钱包确认', 'pending');
          if (phase === 'sent') setStepState('claim', '已发送，等待确认', 'pending');
          if (phase === 'confirmed') setStepState('claim', '已确认', '');
        });
        await recordClaim(position, txHash);
        toast('手续费已领取', '已记录已领 ' + fmtUsd(position.feesUsd) + '，PNL 会继续包含这笔。', 'success');
        closeModal(true); await refreshAll();
      }
    });
  }

  function withdrawalAmounts(position, percent, slip) {
    const liquidity = percent >= 100 ? position.liquidity : position.liquidity * BigInt(percent) / 100n;
    const a = M.amountsForLiquidity(liquidity, position.sqrtLower, position.sqrtUpper, state.pool.sqrtPriceX96);
    return { liquidity, amount0: a.amount0, amount1: a.amount1, min0: a.amount0 * BigInt(10000 - slip) / 10000n, min1: a.amount1 * BigInt(10000 - slip) / 10000n };
  }

  function withdrawBody(position, percent, slip) {
    const e = withdrawalAmounts(position, percent, slip);
    const full = percent >= 100;
    const action = full ? 'BURN_POSITION + TAKE_PAIR' : 'DECREASE_LIQUIDITY + TAKE_PAIR';
    const warning = full
      ? 'DECREASE_LIQUIDITY + TAKE_PAIR；撤出全部流动性和手续费，但不会销毁 NFT。NFT 会变成空仓，默认隐藏；需要时再单独销毁空 NFT。最低数量按 2% 保护。'
      : 'DECREASE_LIQUIDITY + TAKE_PAIR；NFT 会保留。最低数量按 2% 保护。';
    return '<div class="preview-grid"><div class="preview-item"><span>撤出比例</span><strong>' + percent + '%</strong></div><div class="preview-item"><span>滑点</span><strong>' + fmtNum(slip / 100, 2) + '%</strong></div><div class="preview-item"><span>预计 HYPE</span><strong>' + fmtToken(e.amount0, 18, 6) + '</strong></div><div class="preview-item"><span>预计 KNTQ</span><strong>' + fmtToken(e.amount1, 18, 5) + '</strong></div><div class="preview-item"><span>最低 HYPE</span><strong>' + fmtToken(e.min0, 18, 6) + '</strong></div><div class="preview-item"><span>最低 KNTQ</span><strong>' + fmtToken(e.min1, 18, 5) + '</strong></div></div>' +
      '<div class="field" style="margin-top:12px"><span>撤出比例</span><select class="input" id="withdrawPct">' + [25, 50, 75, 100].map((v) => '<option value="' + v + '"' + (v === percent ? ' selected' : '') + '>' + v + '%</option>').join('') + '</select></div>' +
      '<div class="warning-box">' + warning + '</div>' +
      '<div class="preview-section"><h4>执行步骤</h4><div class="preview-list"><div class="preview-step pending" data-step-id="withdraw"><span class="step-index">1</span><div><strong>减少流动性 + 领取本金/手续费</strong><small>modifyLiquidities([DECREASE_LIQUIDITY, TAKE_PAIR])</small></div><span class="step-state">待签名前模拟</span></div></div></div>';
  }

  function openWithdraw(position) {
    if (txBlocked()) { toast('数据过期', '刷新后再撤池。', 'error'); return; }
    const slipPct = 2;
    const slip = 200;
    if (!(slipPct > 0) || slipPct > Number(state.config.safety.maxSlippageBps || 500) / 100) { toast('撤池滑点设置无效', '请联系维护者。', 'error'); return; }
    if (!(position.liquidity > 0n)) { toast('该仓位没有流动性', '可能已撤出。'); return; }
    let percent = 100;
    const render = () => {
      ui.modalBody.innerHTML = withdrawBody(position, percent, slip);
      const select = ui.modalBody.querySelector('#withdrawPct');
      if (select) select.addEventListener('change', () => { percent = Number(select.value); render(); });
    };
    openModal({
      eyebrow: 'WITHDRAW', title: '撤池 · NFT #' + position.tokenId, body: '', confirmText: '模拟并撤池',
      onConfirm: async () => {
        const e = withdrawalAmounts(position, percent, slip);
        if (e.liquidity <= 0n) throw new Error('撤出数量为 0');
        const deadline = nowSec() + 600;
        const data = buildCollectData(position.tokenId, e.liquidity, e.min0, e.min1, deadline);
        const step = { id: 'withdraw', label: '减少流动性 + 领取本金/手续费', detail: percent + '% · 最低 ' + fmtToken(e.min0, 18, 6) + ' HYPE + ' + fmtToken(e.min1, 18, 5) + ' KNTQ', to: getAddress(state.config.uniswap.positionManager), data, value: 0n };
        await executeSteps([step], (s, i, phase) => {
          if (phase === 'simulating') setStepState('withdraw', '模拟中…', 'pending');
          if (phase === 'signing') setStepState('withdraw', '模拟通过 · 请在钱包确认', 'pending');
          if (phase === 'sent') setStepState('withdraw', '已发送，等待确认', 'pending');
          if (phase === 'confirmed') setStepState('withdraw', '已确认', '');
        });
        toast('撤池完成', percent === 100 ? '本金和手续费已撤回；NFT 保留为空仓并默认隐藏，不会被自动销毁。' : '已撤出 ' + percent + '%。', 'success');
        closeModal(true); await refreshAll();
      }
    });
    render();
  }

  function openBurnEmpty(position) {
    if (txBlocked()) { toast('数据过期', '刷新后再销毁。', 'error'); return; }
    const deadline = nowSec() + 600;
    const data = buildBurnData(position.tokenId, 0n, 0n, deadline);
    const step = { id: 'burn', label: '销毁空 NFT', detail: 'BURN_POSITION · NFT #' + position.tokenId, to: getAddress(state.config.uniswap.positionManager), data, value: 0n };
    openModal({
      eyebrow: 'BURN EMPTY NFT', title: '销毁空仓 NFT #' + position.tokenId,
      body: '<div class="warning-box">这个 NFT 已没有流动性。BURN_POSITION 会销毁 NFT，之后 Ascend 和其他仓位列表不会再显示它。</div><div class="preview-section"><h4>执行步骤</h4><div class="preview-list">' + planStepHtml(step, 0) + '</div></div>',
      confirmText: '模拟并销毁',
      onConfirm: async () => {
        await executeSteps([step], (s, i, phase) => {
          if (phase === 'simulating') setStepState('burn', '模拟中…', 'pending');
          if (phase === 'signing') setStepState('burn', '模拟通过 · 请在钱包确认', 'pending');
          if (phase === 'sent') setStepState('burn', '已发送，等待确认', 'pending');
          if (phase === 'confirmed') setStepState('burn', '已确认', '');
        });
        await clearClaim(position.tokenId);
        toast('空 NFT 已销毁', 'Ascend 不会再列出这个仓位。', 'success');
        closeModal(true); await refreshAll();
      }
    });
  }

  function openWalletModal() {
    if (!state.wallet.address) return;
    const chainOk = state.wallet.chainId === Number(state.config.network.chainId);
    const readOnly = state.wallet.readOnly;
    openModal({
      eyebrow: 'WALLET', title: readOnly ? '只读地址' : '钱包与网络',
      body: '<div class="preview-grid"><div class="preview-item"><span>账户</span><strong>' + escapeHtml(state.wallet.address) + '</strong></div><div class="preview-item"><span>模式</span><strong class="' + (readOnly ? 'gain' : '') + '">' + (readOnly ? '只读看板' : '浏览器钱包') + '</strong></div><div class="preview-item"><span>网络</span><strong class="' + (chainOk ? 'gain' : '') + '">' + (chainOk ? state.config.network.name : 'chainId ' + state.wallet.chainId + '（不匹配）') + '</strong></div><div class="preview-item"><span>HYPE</span><strong>' + fmtToken(state.balances.hype, 18, 5) + '</strong></div><div class="preview-item"><span>KNTQ</span><strong>' + fmtToken(state.balances.kntq, 18, 5) + '</strong></div><div class="preview-item"><span>Elysium V4 仓位</span><strong>' + state.positions.length + '</strong></div></div>' +
        '<div class="warning-box">' + (readOnly ? '手机看板默认读取这个地址，不连接钱包、不签名。' : '工具只读取公开链上数据；签名始终在钱包内完成。断开只清除本页面连接状态，不会撤销钱包授权。') + '</div>',
      confirmText: readOnly ? '连接钱包' : '断开界面连接',
      onConfirm: async () => { if (readOnly) { closeModal(true); await connectWallet(); return; } disconnectWallet(); closeModal(true); }
    });
  }

  function openStatusModal() {
    if (!state.status) { toast('状态未就绪', '请稍后重试。', 'error'); return; }
    const s = state.status;
    const market = state.market || s.market;
    const rows = (s.rpc?.endpoints || []).map((e) => '<div class="status-item"><div><strong>' + escapeHtml(e.name + (s.rpc.active === e.name ? ' · 当前' : '')) + '</strong><small>' + escapeHtml(e.url) + '</small></div><div class="status-meta">' + (e.latencyMs == null ? '未测' : e.latencyMs + 'ms') + '<br>' + (e.cooldown ? '冷却中' : e.failures > 0 ? '异常 ' + e.failures : '正常') + '</div></div>').join('');
    openModal({
      eyebrow: 'SYSTEM STATUS', title: 'RPC / 行情状态',
      body: '<div class="preview-grid"><div class="preview-item"><span>Chain ID</span><strong class="' + (s.ok ? 'gain' : '') + '">' + (s.chainId || s.expectedChainId) + '</strong></div><div class="preview-item"><span>最新区块</span><strong>' + (s.head?.blockNumber ? '#' + s.head.blockNumber : '—') + '</strong></div><div class="preview-item"><span>区块延迟</span><strong>' + (s.head?.ageSec != null ? fmtAge(s.head.ageSec) : '—') + '</strong></div><div class="preview-item"><span>HYPE 行情</span><strong>' + (market?.price != null ? fmtUsd(market.price) + ' · ' + fmtAge(market.ageSec) : '不可用') + '</strong></div></div>' +
        '<div class="preview-section"><h4>RPC 故障切换池</h4><div class="status-list">' + rows + '</div></div><div class="warning-box">前端读取和模拟只经过本机只读代理；钱包广播使用钱包自己的 RPC。chainId 不一致时工具会停止签名。</div>',
      confirmText: '刷新状态', onConfirm: async () => { await loadStatus(); await loadMarket(); await refreshAll(); closeModal(true); }
    });
  }

  function updateFooter() {
    ui.footerUpdated.textContent = state.lastReadAt ? '更新 ' + fmtAge((Date.now() - state.lastReadAt) / 1000) : '更新 —';
  }

  function tick() { updateMarketUi(); updateStaleUi(); updateFooter(); }

  function scheduleRetry() {
    if (state.retryTimer) return;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      poll().catch(() => scheduleRetry());
    }, 10000);
  }

  async function checkPositionBalance() {
    if (document.hidden || state.refreshing || !state.wallet.address) return;
    if (state.wallet.chainId !== Number(state.config.network.chainId)) return;
    const cached = state.positionIds[state.wallet.address.toLowerCase()];
    if (!cached || cached.balance == null) return;
    try {
      const pm = getAddress(state.config.uniswap.positionManager);
      const raw = await ethCall(pm, callData(iface.pm, 'balanceOf', [state.wallet.address]));
      const balance = Number(BigInt(raw));
      if (balance !== Number(cached.balance)) {
        state.forceLogs = true;
        await refreshAll();
      }
    } catch (_) { /* next poll */ }
  }

  async function poll() {
    if (document.hidden) return;
    await Promise.all([loadStatus(), loadMarket()]);
    await refreshAll();
  }

  function bindEvents() {
    ui.connectBtn.addEventListener('click', async () => {
      if (state.wallet.readOnly) { openWalletModal(); return; }
      if (!state.wallet.address) { await connectWallet(); return; }
      if (state.wallet.chainId !== Number(state.config.network.chainId)) {
        try { await ensureWalletChain(true); await setupProvider(); updateWalletUi(); await refreshAll(); } catch (e) { toast('网络切换失败', decodeErr(e), 'error'); }
        return;
      }
      openWalletModal();
    });
    if (ui.walletMenuBtn) {
      ui.walletMenuBtn.addEventListener('click', () => {
        openModal({ eyebrow: 'WALLET', title: '断开钱包连接？', body: '<div class="warning-box">只会清除本页面连接状态，不会撤销钱包授权或影响链上资产。</div>', confirmText: '断开', onConfirm: async () => { disconnectWallet(); closeModal(true); } });
      });
    }
    ui.rpcBadge.addEventListener('click', openStatusModal);
    ui.refreshBtn.addEventListener('click', async () => { state.forceLogs = true; await poll(); toast('已刷新', '链上快照与行情已更新。'); });
    if (ui.emptyBurnBtn) ui.emptyBurnBtn.addEventListener('click', openBurnAllEmpty);
    if (ui.cleanupEmptyBtn) ui.cleanupEmptyBtn.addEventListener('click', openBurnAllEmpty);
    ui.staleRefreshBtn.addEventListener('click', async () => { await poll(); });
    ui.sortSelect.addEventListener('change', () => { state.sort = ui.sortSelect.value; writeStorage('sort', state.sort); renderPositions(); });
    ui.hideClosed.addEventListener('change', () => { state.hideClosed = ui.hideClosed.checked; writeStorage('hide-closed', state.hideClosed ? '1' : '0'); renderPositions(); });
    if (ui.hypeInput) {
      ui.hypeInput.addEventListener('input', () => {
        state.compose.hype = ui.hypeInput.value;
        state.compose.lastEdited = 'hype';
        scheduleQuote();
      });
    }
    if (ui.kntqInput) {
      ui.kntqInput.addEventListener('input', () => {
        state.compose.kntq = ui.kntqInput.value;
        state.compose.lastEdited = 'kntq';
        scheduleQuote();
      });
    }
    if (ui.maxHypeBtn) {
      ui.maxHypeBtn.addEventListener('click', () => {
        if (!state.wallet.address) { toast('请先连接钱包', '连接后才能读取余额。', 'error'); return; }
        const reserve = parseUnitsSafe(state.config.safety.gasReserveHype || '0.02', 18);
        const slipPct = parseFloatSafe(ui.slippageInput?.value) || 0.5;
        const free = state.balances.hype > reserve ? state.balances.hype - reserve : 0n;
        const value = free * 10000n / BigInt(10000 + Math.max(1, Math.round(slipPct * 100)));
        state.compose.hype = ethers.formatUnits(value, 18).replace(/\.?0+$/, '');
        state.compose.lastEdited = 'hype';
        setInputValue(ui.hypeInput, state.compose.hype);
        scheduleQuote(true);
      });
    }
    if (ui.maxKntqBtn) {
      ui.maxKntqBtn.addEventListener('click', () => {
        if (!state.wallet.address) { toast('请先连接钱包', '连接后才能读取余额。', 'error'); return; }
        const slipPct = parseFloatSafe(ui.slippageInput?.value) || 0.5;
        const usable = state.balances.kntq * BigInt(Math.max(1, Math.round(10000 - slipPct * 100))) / 10000n;
        state.compose.kntq = ethers.formatUnits(usable, 18).replace(/\.?0+$/, '');
        state.compose.lastEdited = 'kntq';
        setInputValue(ui.kntqInput, state.compose.kntq);
        scheduleQuote(true);
      });
    }
    if (ui.rangePresets) {
      ui.rangePresets.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-preset]');
        if (!btn) return;
        state.compose.preset = btn.dataset.preset;
        if (state.compose.preset === 'custom') ensureCustomTicks();
        updatePresetUi();
        try { updateRangeUi(selectedRange()); } catch (_) { updateRangeUi(null); }
        scheduleQuote(true);
      });
    }
    if (ui.slippageInput) ui.slippageInput.addEventListener('input', () => { state.compose.slippagePct = parseFloatSafe(ui.slippageInput.value); updateComposeUi(); scheduleQuote(); });
    if (ui.previewBtn) ui.previewBtn.addEventListener('click', () => { previewBuild().catch((error) => toast('预览失败', decodeErr(error), 'error')); });
    if (ui.emptyComposeBtn) ui.emptyComposeBtn.addEventListener('click', () => { const node = ui.hypeInput || ui.composer; if (node) node.focus(); });
    if (ui.refreshBalBtn) ui.refreshBalBtn.addEventListener('click', async () => { try { await refreshBalances(); scheduleQuote(true); toast('余额已刷新', '已重新读取钱包余额。', 'success'); } catch (error) { toast('余额刷新失败', decodeErr(error), 'error'); } });
    if (ui.reauthBtn) ui.reauthBtn.addEventListener('click', openReauth);
    if (ui.rangeMin) ui.rangeMin.addEventListener('input', applySliderTicks);
    if (ui.rangeMax) ui.rangeMax.addEventListener('input', applySliderTicks);
    if (ui.rangeZoomIn) ui.rangeZoomIn.addEventListener('click', () => zoomCustomRange(0.75));
    if (ui.rangeZoomOut) ui.rangeZoomOut.addEventListener('click', () => zoomCustomRange(1.33));
    ui.positionsGrid.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-action]');
      if (!btn) return;
      const id = btn.getAttribute('data-token-id');
      const p = state.positions.find((x) => x.tokenId.toString() === id);
      if (!p) return;
      if (btn.getAttribute('data-action') === 'claim') openClaim(p);
      if (btn.getAttribute('data-action') === 'withdraw') openWithdraw(p);
      if (btn.getAttribute('data-action') === 'burn') openBurnEmpty(p);
    });
    if (ui.chartTabs) {
      ui.chartTabs.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-tf]');
        if (!btn) return;
        ui.chartTabs.querySelectorAll('button').forEach((n) => n.classList.toggle('active', n === btn));
        state.chart.tf = btn.getAttribute('data-tf');
        loadChart().catch(() => {});
      });
    }
    if (ui.chartInvert) {
      ui.chartInvert.addEventListener('click', () => {
        state.chart.invert = !state.chart.invert;
        ui.chartInvert.textContent = state.chart.invert ? 'KNTQ/HYPE' : 'HYPE/KNTQ';
        loadChart().catch(() => {});
      });
    }
    window.addEventListener('resize', () => { clearTimeout(state.chart.resizeTimer); state.chart.resizeTimer = setTimeout(drawChart, 120); });
    ui.modalClose.addEventListener('click', () => closeModal());
    ui.modalCancel.addEventListener('click', () => closeModal());
    ui.modalBackdrop.addEventListener('click', (e) => { if (e.target === ui.modalBackdrop) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    if (window.ethereum?.on) { window.ethereum.on('accountsChanged', onAccountsChanged); window.ethereum.on('chainChanged', onChainChanged); }
  }

  async function trySilentConnect() {
    if (state.wallet.readOnly) return;
    if (!window.ethereum?.request) return;
    try {
      const accounts = await window.ethereum.request({ method: 'eth_accounts' });
      if (!accounts?.length) return;
      state.wallet.address = getAddress(accounts[0]);
      const hex = await window.ethereum.request({ method: 'eth_chainId' });
      state.wallet.chainId = Number(BigInt(hex));
      await setupProvider();
      updateWalletUi();
      await refreshAll();
    } catch (_) { /* optional */ }
  }

  async function init() {
    bindEvents();
    try { await loadConfig(); }
    catch (error) {
      ui.staleBanner.hidden = false; ui.staleTitle.textContent = '无法加载配置'; ui.staleText.textContent = decodeErr(error); if (ui.previewBtn) ui.previewBtn.disabled = true; return;
    }
    renderPositions(); updateStaleUi();
    await Promise.all([loadStatus(), loadMarket()]);
    await refreshAll();
    await trySilentConnect();
    updateFooter();
    setInterval(tick, 1000);
    setInterval(poll, Number(state.config.ui.pollSeconds || 12) * 1000);
    setInterval(checkPositionBalance, 15000);
  }

  init();
})();
