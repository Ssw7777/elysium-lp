# Elysium LP Dashboard

A read-only Uniswap V4 LP dashboard for **KNTQ/HYPE on Elysium mainnet (chainId 99901)**.

一个只读的 **Elysium 主网 KNTQ/HYPE Uniswap V4 流动性看板**。

- [中文说明](README.zh-CN.md)
- [English documentation](README.en.md)

## What it does / 功能

- Reads real V4 pool state and positions from Elysium.
- Shows entry value, current value, net PnL, IL, pending fees, 5m/30m/1h APR and next-day yield.
- Uniswap-style liquidity distribution (KNTQ/USDT display), with current-price highlight, statistics and range table.
- Read-only by default; no private keys, no transaction broadcasting, no automatic slippage or retries.
- Optional mobile watch mode: set `ui.defaultAddress` in `config.json`.
- Optional hourly Bark report (pending fees + net PnL + range distance).

## Read-only / 只读

This project never asks for a mnemonic or private key. It only reads public RPC data. Wallet signing is outside this repository.

## Quick start / 快速开始

```bash
git clone https://github.com/Ssw7777/elysium-lp.git
cd elysium-lp
python3 server.py --no-open --port 8097
# open http://127.0.0.1:8097/elysium-lp/
```

No third-party Python packages are required. The ethers.js browser bundle is vendored for offline use.

## Configuration / 配置

Edit `config.json`:

- `network.rpcUrls`: official RPC first, fallback second.
- `uniswap.*`: public pool and contract addresses.
- `ui.defaultAddress`: leave empty to connect a wallet; set an address for mobile read-only mode.
- `ui.watchOnly`: informational.
- `safety.*`: stale thresholds and display limits.

Do not put private keys, API tokens or personal server details in this file.

## Optional hourly Bark report / Bark 小时报

`scripts/hourly_report.js` is an optional read-only Node.js job:

```bash
export BARK_KEY="your-bark-key"
export DEFAULT_ADDRESS="0x..."
node scripts/hourly_report.js
```

It sends one message per hour with pending fees, net PnL, range distance and timestamp. `isArchive: 1` is set so the message stays in Bark history. The script never signs transactions.

## Data and formulas / 数据说明

- Positions are enumerated from PositionManager `Transfer` logs and filtered with `ownerOf`.
- V4 position key: `keccak256(abi.encodePacked(positionManager, int24 tickLower, int24 tickUpper, bytes32 tokenId))`.
- Pending fees: `liquidity * (feeGrowthInside - feeGrowthInsideLast) >> 128`.
- Entry value uses the mint block's `getSlot0`/`getPositionLiquidity` and Hyperliquid HYPE 1h candles.
- KNTQ/USDT is derived from the KNTQ/HYPE pool price times HYPE/USDT. It is not a separate KNTQ/USDT pool.
- Liquidity distribution is computed from `StateView.getTickBitmap` + `getTickLiquidity`.

## Limitations / 限制

- Single pool: KNTQ/HYPE. Other-pool dashboards are not included.
- PnL currently includes **pending** fees, not already-claimed fees.
- If liquidity was added after mint, entry value is approximate.
- Read-only; adding liquidity is done elsewhere.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Not financial advice.
