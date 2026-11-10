# Elysium LP Dashboard · English

An **Elysium mainnet (chainId 99901) Uniswap V4 KNTQ/HYPE LP dashboard**. Chain data is read-only; an optional browser wallet is the only signer for claiming fees or withdrawing liquidity.

## Features

- Reads real V4 pool state, positions, ticks and liquidity distribution from Elysium.
- Two official KNTQ/HYPE Uniswap V4 pools: **1%** (`fee` 10000, `tickSpacing` 200, poolId `0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac`) and **0.3%** (`fee` 3000, `tickSpacing` 60, hooks `0`, poolId `0xf9b8a9101438145d62c9f03156b203c6c573931167e2d36f9061a32575706c8a`). Switch the fee tier for price, distribution and new liquidity. Totals always include both pools, and each NFT is priced with its own poolKey.
- Entry value, current value, net PnL, impermanent loss (IL), pending fees and **claimed fees**.
- Claimed fees stay in PnL until an optional empty-NFT burn; a normal full withdrawal does not clear them. The position card shows the cumulative claimed USD amount.
- 5m / 30m / 1h APR, next-day estimated yield, a 20-second price/valuation refresh and a 60-second full position scan.
- Uniswap-style KNTQ/USDT liquidity distribution: current-price highlight, statistics panel and range table.
- Direct KNTQ/USDT OKX chart link in the header; OKX blocks iframe embedding (`X-Frame-Options: DENY`), so it opens in a new tab.
- HYPE-denominated strip at the bottom: Elysium wallet + LP principal + HyperEVM wallet, with an optional reference amount.
- Add-liquidity panel: free input on either side, auto-ratio, ±2/±5/±10/±25/±50/full/custom ranges, slippage preview, Permit2 approvals and V4 mint; wallet balances refresh automatically.
- Sticky section navigation, ±2/5/10% range APR estimates, 5m–24h volume/fee windows and a read-only watched-address panel.
- Optional browser-wallet mode for claiming fees and withdrawing liquidity. OKX Wallet's built-in Elysium network is supported; the app does not create a custom network on OKX.
- A 15-second PositionManager `balanceOf` watcher detects new positions, then re-reads logs.
- Optional periodic Bark report with pending fees, net PnL, claimed fees, range distance, HYPE total and timestamp.
- Official Elysium RPC only; no third-party RPC fallback.

## Read-only and signing

The server never asks for a mnemonic or private key and never broadcasts a transaction. Only a confirmed claim/withdraw is signed in the browser wallet. There is no automatic slippage widening, transaction resend or private-key handling.

`ui.defaultAddress` is empty by default, so the page starts in wallet-connect mode and tells you to connect a wallet. Set a public address only in a local uncommitted config for a read-only view. `ui.hypeReference` stays `0` in git.

## Quick start

```bash
git clone https://github.com/Ssw7777/elysium-lp-26-11-9.git
cd elysium-lp
python3 server.py --no-open --port 8097
# open http://127.0.0.1:8097/elysium-lp/
```

No third-party Python packages are required. The ethers.js browser bundle is vendored under `public/vendor/`.

## Configuration

Edit `config.json`:

- `network.rpcUrls`: official Elysium RPC.
- `uniswap.*` and `uniswap.pools`: public PoolManager, StateView, PositionManager and the two pool descriptors above. `uniswap.poolId` is the default 1% view.
- `ui.defaultAddress`: keep `""` in git. Connect a wallet, or set a public address only in a local uncommitted config.
- `ui.hypeReference`: keep `0` in git. It is an optional personal baseline, not something stored in the repository.
- `ui.hyperEvmRpc`: HyperEVM RPC for the HYPE wallet balance.
- `safety.*`: stale thresholds and display limits.

Never put private keys, exchange API keys, Bark keys or personal server details in `config.json`.

## Claimed-fee journal

After a claim is confirmed, the frontend posts owner, token id, claimed HYPE/KNTQ amounts, USD value and transaction hash to `POST /api/claim`. The server appends it to:

```text
~/.elysium-lp-claims.json
```

`GET /api/claims?owner=0x...` returns one owner's journal. The journal entry is cleared only by the optional empty-NFT burn via `POST /api/claim/clear`. A normal 100% withdrawal keeps the entry so claimed fees remain in PnL.

PnL is calculated as:

```text
principal + pending fees + cumulative claimed fees - entry value
```

The journal contains no keys, but it is still private data. **Put the app behind authentication (for example, Caddy `forward_auth`) before exposing it.** Do not expose the claim endpoints as an unauthenticated public write API.

## Optional periodic Bark report

`report.js` is the optional read-only Node.js job. It covers both configured pools, prices each NFT from that NFT's own poolKey, retries transient RPC failures, and refuses to send Bark when a previously active position is neither confirmed closed nor fully read.

```bash
export BARK_KEY="your-bark-key"
export DEFAULT_ADDRESS="0xYourPublicAddress"
node report.js
```

`scripts/hourly_report.js` only forwards to `report.js` once. Schedule one of them, not both. With no wallet configured, the job prints how to set `DEFAULT_ADDRESS` and exits before any RPC call or failure push.

It sends pending fees, net PnL, claimed fees, range distance, HYPE total and timestamp. `isArchive: 1` keeps the message in Bark history. The script never signs transactions.

Example units are in `deploy/`. This repository does not enable GitHub Actions or a timer. A local `OnCalendar=*:0/5` timer is a five-minute cadence. Keep `BARK_KEY` in a mode-`600` or `640` `EnvironmentFile`, not in the repository.

### Bark alerts

The 5-minute report also evaluates the **freshly read current positions**:

- **Out of range**: alert when a live position leaves its range; repeat at most every 30 minutes while it stays out; clear the state when it returns, is withdrawn, burned or has zero liquidity.
- **5m APR > 20,000%**: alert when the 5-minute fee-growth APR crosses the threshold; repeat at most every 30 minutes.
- Alerts are skipped if the position set is incomplete, so a stale/removed range is never used. When all LP positions are gone, one final **“Elysium LP 已清空”** notice is sent and periodic reports pause; a new LP automatically resumes them. Alert state is private and stored outside the repository.

## Data notes

- Positions are enumerated from PositionManager `Transfer` logs and filtered with `ownerOf`; `balanceOf` is checked to catch new mints quickly.
- V4 position key: `keccak256(abi.encodePacked(positionManager, int24 tickLower, int24 tickUpper, bytes32 tokenId))`.
- Pending fees: `liquidity * (feeGrowthInside - feeGrowthInsideLast) >> 128`.
- Entry value uses the mint block's `getSlot0` + `getPositionLiquidity`, with HYPE historical 1h candles from Hyperliquid.
- KNTQ/USDT is derived from the KNTQ/HYPE pool price multiplied by HYPE/USDT. It is not a separate KNTQ/USDT pool.
- Liquidity distribution uses `StateView.getTickBitmap` + `getTickLiquidity`.
- HYPE total = Elysium wallet (HYPE + wallet KNTQ converted to HYPE) + LP current value (principal + pending fees) + HyperEVM (chain 999) wallet HYPE. Claimed fees are already in the wallet.

## Limitations

- KNTQ/HYPE only, on the 1% and 0.3% pools above. Other pairs are not included.
- Built-in add-liquidity panel; there is no automatic swap, rebalancing or transaction retry.
- Entry value is approximate if liquidity was added after mint.
- Claimed-fee history starts when this journal feature is deployed. Claims made directly in a wallet or before the feature are not reconstructed automatically.
- HYPE/USD and KNTQ/USD are market estimates, not execution guarantees.

## Secure self-hosting

- Run `server.py` on `127.0.0.1` and put your own reverse proxy, with authentication, in front. Do not publish port 8097.
- Do not commit wallets, Bark device keys, claim journals, alert state, HYPE baselines or NFT lists. Runtime files are gitignored. Examples live in `deploy/*.example`.
- `deploy_vps.sh` installs the localhost web service only after `ELYSIUM_INSTALL=1`. It does not install the Bark timer.
- This repository does not include a separate login app. Keep production proxy config and EnvironmentFiles off git.
- Only public chain addresses and the two pool ids belong in `config.json`.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Not financial advice.
