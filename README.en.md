# Elysium LP Dashboard · English

An **Elysium mainnet (chainId 99901) Uniswap V4 KNTQ/HYPE LP dashboard**. Chain data is read-only; an optional browser wallet is the only signer for claiming fees or withdrawing liquidity.

## Features

- Reads real V4 pool state, positions, ticks and liquidity distribution from Elysium.
- Entry value, current value, net PnL, impermanent loss (IL), pending fees and **claimed fees**.
- Claimed fees stay in PnL until the position is fully withdrawn; the position card shows the cumulative claimed USD amount.
- 5m / 30m / 1h APR, next-day estimated yield and a 60-second refresh.
- Uniswap-style KNTQ/USDT liquidity distribution: current-price highlight, statistics panel and range table.
- HYPE-denominated strip at the bottom: Elysium wallet + LP principal + HyperEVM wallet, with an optional reference amount.
- Add-liquidity panel: free input on either side, auto-ratio, range presets/custom range, slippage preview, Permit2 approvals and V4 mint.
- Optional browser-wallet mode for claiming fees and withdrawing liquidity. OKX Wallet's built-in Elysium network is supported; the app does not create a custom network on OKX.
- A 15-second PositionManager `balanceOf` watcher detects new positions, then re-reads logs.
- Optional periodic Bark report with pending fees, net PnL, claimed fees, range distance, HYPE total and timestamp.
- Official Elysium RPC only; no third-party RPC fallback.

## Read-only and signing

The server never asks for a mnemonic or private key and never broadcasts a transaction. Only a confirmed claim/withdraw is signed in the browser wallet. There is no automatic slippage widening, transaction resend or private-key handling.

`ui.defaultAddress` is empty by default, so the page starts in wallet-connect mode. Set a public address there only for a read-only mobile view.

## Quick start

```bash
git clone https://github.com/Ssw7777/elysium-lp.git
cd elysium-lp
python3 server.py --no-open --port 8097
# open http://127.0.0.1:8097/elysium-lp/
```

No third-party Python packages are required. The ethers.js browser bundle is vendored under `public/vendor/`.

## Configuration

Edit `config.json`:

- `network.rpcUrls`: official Elysium RPC.
- `uniswap.*`: public pool, PoolManager, StateView and PositionManager addresses.
- `ui.defaultAddress`: leave empty to connect a wallet; set an address for read-only viewing.
- `ui.hypeReference`: optional HYPE amount used only as a reference in the HYPE strip. Use `0` to hide it.
- `ui.hyperEvmRpc`: HyperEVM RPC for the HYPE wallet balance.
- `safety.*`: stale thresholds and display limits.

Never put private keys, exchange API keys, Bark keys or personal server details in `config.json`.

## Claimed-fee journal

After a claim is confirmed, the frontend posts owner, token id, claimed HYPE/KNTQ amounts, USD value and transaction hash to `POST /api/claim`. The server appends it to:

```text
~/.elysium-lp-claims.json
```

`GET /api/claims?owner=0x...` returns one owner's journal. A successful 100% withdrawal calls `POST /api/claim/clear`, which removes that token's entry only after the position is gone. Partial withdrawals keep it.

PnL is calculated as:

```text
principal + pending fees + cumulative claimed fees - entry value
```

The journal contains no keys, but it is still private data. **Put the app behind authentication (for example, Caddy `forward_auth`) before exposing it.** Do not expose the claim endpoints as an unauthenticated public write API.

## Optional periodic Bark report

`scripts/hourly_report.js` is an optional read-only Node.js job. The filename is kept for compatibility; run it at any interval, for example every five minutes:

```bash
export BARK_KEY="your-bark-key"
export DEFAULT_ADDRESS="0x..."
node scripts/hourly_report.js
```

It sends pending fees, net PnL, claimed fees, range distance, HYPE total and timestamp. `isArchive: 1` keeps the message in Bark history. The script never signs transactions.

A systemd timer such as `OnCalendar=*:0/5` gives a five-minute cadence. Keep `BARK_KEY` in a mode-`600` `EnvironmentFile`, not in the repository.

## Data notes

- Positions are enumerated from PositionManager `Transfer` logs and filtered with `ownerOf`; `balanceOf` is checked to catch new mints quickly.
- V4 position key: `keccak256(abi.encodePacked(positionManager, int24 tickLower, int24 tickUpper, bytes32 tokenId))`.
- Pending fees: `liquidity * (feeGrowthInside - feeGrowthInsideLast) >> 128`.
- Entry value uses the mint block's `getSlot0` + `getPositionLiquidity`, with HYPE historical 1h candles from Hyperliquid.
- KNTQ/USDT is derived from the KNTQ/HYPE pool price multiplied by HYPE/USDT. It is not a separate KNTQ/USDT pool.
- Liquidity distribution uses `StateView.getTickBitmap` + `getTickLiquidity`.
- HYPE total = Elysium wallet HYPE + LP current value (principal + pending fees) converted to HYPE + HyperEVM (chain 999) wallet HYPE. Claimed fees are tracked separately.

## Limitations

- Single pool: KNTQ/HYPE. Other-pool dashboards are not included.
- Adding liquidity is not part of this repository; use another tool.
- Entry value is approximate if liquidity was added after mint.
- Claimed-fee history starts when this journal feature is deployed. Claims made directly in a wallet or before the feature are not reconstructed automatically.
- HYPE/USD and KNTQ/USD are market estimates, not execution guarantees.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Not financial advice.
