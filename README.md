# Elysium LP Dashboard

An **Elysium mainnet (chainId 99901) Uniswap V4 KNTQ/HYPE LP dashboard**. On-chain data is read-only; a browser wallet is optional and is the only signer for claiming fees or withdrawing liquidity.

一个 **Elysium 主网（chainId 99901）KNTQ/HYPE Uniswap V4 流动性看板**。链上数据只读；领取手续费或撤池时由浏览器钱包签名，服务端不接触私钥。

- [中文说明](README.zh-CN.md)
- [English documentation](README.en.md)

## Features / 功能

- Reads real V4 pool state, positions, ticks and liquidity distribution from Elysium.
- Entry value, current value, net PnL, IL, pending fees and **claimed fees**.
- **Claimed fees are kept in PnL** until an optional empty-NFT burn; a normal full withdrawal does not clear them. The position card shows the cumulative claimed USD amount.
- 5m / 30m / 1h APR, next-day estimated yield, a 20-second price/valuation refresh and a 60-second full position scan.
- Uniswap-style KNTQ/USDT liquidity distribution, current-price highlight, stats and range table.
- Direct KNTQ/USDT chart link to OKX in the header; OKX blocks iframe embedding (`X-Frame-Options: DENY`), so it opens in a new tab.
- HYPE-denominated strip at the bottom: Elysium wallet + LP principal + HyperEVM wallet, with an optional reference amount.
- Add-liquidity panel: free input on either side, auto-ratio, range presets/custom range, slippage preview, Permit2 approvals and V4 mint.
- Optional browser-wallet mode for claiming fees / withdrawing liquidity. OKX Wallet's built-in Elysium network is supported; the app does not create a custom network on OKX.
- New positions are detected by a 15-second PositionManager `balanceOf` watcher, then a fresh log read.
- Optional periodic Bark report. The sample job sends pending fees, net PnL, claimed fees, range distance, HYPE total and timestamp; `isArchive: 1` keeps history.
- Official Elysium RPC only; no third-party RPC fallback.

## Read-only and signing / 只读与签名

The server never asks for a mnemonic or private key and never broadcasts a transaction. The browser wallet signs only claim, withdraw and add-liquidity transactions. There is no automatic slippage widening, transaction resend or private-key handling.

In the default configuration `ui.defaultAddress` is empty, so the page starts in wallet-connect mode. Set a public address there only if you want a read-only mobile view.

## Using the dashboard / 使用说明

1. **Connect a wallet** in the top-right. Read-only data is always visible; signing is only needed for claim, withdraw and add-liquidity actions.
2. **Positions** show entry value, current value, PnL, pending/claimed fees, and a two-line range panel. Card backgrounds are green in range, yellow when either edge is within 3%, and red out of range.
3. **Add liquidity** is below the distribution card. Enter either HYPE or KNTQ, use MAX (a slippage buffer is reserved), choose a preset range or drag the two custom handles, then preview and confirm. Approvals are explicit and limited to the required amount.
4. **Claimed fees** remain in PnL and in the journal after a normal full withdrawal. The empty NFT is hidden; burning it is a separate optional action.
5. **HYPE reference** is editable in the HYPE strip and saved to the local server so the Bark report uses the same value. The website re-prices about every 20 seconds; full position discovery runs every 60 seconds.
6. **KNTQ/USDT chart** opens the OKX page in a new tab from the header; OKX blocks iframe embedding.

## Quick start / 快速开始

```bash
git clone https://github.com/Ssw7777/elysium-lp.git
cd elysium-lp
python3 server.py --no-open --port 8097
# open http://127.0.0.1:8097/elysium-lp/
```

No third-party Python packages are required. The ethers.js browser bundle is vendored under `public/vendor/`.

## Configuration / 配置

Edit `config.json`:

- `network.rpcUrls`: official Elysium RPC.
- `uniswap.*`: public pool, PoolManager, StateView and PositionManager addresses.
- `ui.defaultAddress`: leave empty to connect a wallet; set an address for read-only viewing.
- `ui.hypeReference`: optional HYPE amount used only as a reference line in the HYPE strip. Use `0` to hide the reference. The HYPE strip also has an inline editor; saving updates the local server reference used by the Bark report.
- `ui.hyperEvmRpc`: HyperEVM RPC used for the HYPE wallet balance.
- `safety.*`: stale thresholds and display limits.

Never put private keys, exchange API keys, Bark keys or personal server details in `config.json`.

## Claimed-fee journal / 已领手续费记录

When a claim transaction is confirmed, the frontend posts the owner, token id, claimed HYPE/KNTQ amounts, USD value and transaction hash to `POST /api/claim`. The server appends it to a local JSON journal:

```text
~/.elysium-lp-claims.json
```

`GET /api/claims?owner=0x...` returns the journal for one owner. The journal entry is cleared only by the optional empty-NFT burn via `POST /api/claim/clear`. A normal 100% withdrawal keeps the entry so claimed fees remain in PnL.

PnL is calculated as:

```text
principal + pending fees + cumulative claimed fees - entry value
```

A full withdrawal uses `DECREASE_LIQUIDITY + TAKE_PAIR` and **does not burn the NFT** by default; the empty NFT is hidden in the UI and claimed fees remain in the journal. Destroying an empty NFT is a separate, optional `BURN_POSITION + TAKE_PAIR` action with its own confirmation. The journal and the mutating `/api/claim` endpoints contain no keys, but they are still private data. **Put the app behind authentication (for example, Caddy `forward_auth`) before exposing it to the internet.** Do not expose the claim endpoints as an unauthenticated public write API.

## Optional periodic Bark report / Bark 定时报告

`scripts/hourly_report.js` is an optional read-only Node.js job. The filename is kept for compatibility; run it at any interval, for example every 5 minutes:

```bash
export BARK_KEY="your-bark-key"
export DEFAULT_ADDRESS="0x..."
node scripts/hourly_report.js
```

It sends pending fees, net PnL, claimed fees, range distance, HYPE total and timestamp. `isArchive: 1` keeps the message in Bark history. The script never signs transactions.

If you use systemd, a timer such as `OnCalendar=*:0/5` gives a five-minute cadence. Keep `BARK_KEY` in an `EnvironmentFile` with mode `600`, not in the repository.

## Data and formulas / 数据说明

- Positions are enumerated from PositionManager `Transfer` logs and filtered with `ownerOf`; `balanceOf` is checked to catch new mints quickly.
- V4 position key: `keccak256(abi.encodePacked(positionManager, int24 tickLower, int24 tickUpper, bytes32 tokenId))`.
- Pending fees: `liquidity * (feeGrowthInside - feeGrowthInsideLast) >> 128`.
- Entry value uses the mint block's `getSlot0`/`getPositionLiquidity` and Hyperliquid HYPE 1h candles.
- KNTQ/USDT is derived from the KNTQ/HYPE pool price times HYPE/USDT. It is not a separate KNTQ/USDT pool.
- Liquidity distribution uses `StateView.getTickBitmap` + `getTickLiquidity`.
- HYPE total = Elysium wallet (HYPE + KNTQ converted to HYPE) + LP current value (principal + pending fees) converted to HYPE + HyperEVM (chain 999) wallet HYPE. Claimed fees are already in the wallet.

## Limitations / 限制

- Single pool: KNTQ/HYPE. Other-pool dashboards are not included.
- Built-in add-liquidity panel; there is no automatic swap, rebalancing or transaction retry.
- If liquidity was added after mint, entry value is approximate.
- Claimed-fee history is recorded from this UI after the journal feature is deployed. Claims made directly in a wallet or before the feature are not reconstructed automatically.
- HYPE/USD and KNTQ/USD are market estimates, not execution guarantees.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Not financial advice.
