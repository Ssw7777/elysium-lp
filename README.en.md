# Elysium LP Dashboard · English

A read-only **Uniswap V4 KNTQ/HYPE LP dashboard on Elysium mainnet (chainId 99901)**. No private keys and no transaction broadcasting.

## Features

- Reads real V4 pool state and wallet NFT positions.
- Entry value, current value, net PnL, impermanent loss (IL), and pending fees.
- 5m / 30m / 1h APR and next-day estimated yield.
- Uniswap-style liquidity distribution: KNTQ/USDT price histogram, current-price highlight, statistics panel and range table.
- Range distance, position age and entry price.
- Mobile read-only mode: set `ui.defaultAddress` in `config.json`; no wallet connection needed.
- Optional hourly Bark report with pending fees, net PnL and range distance; messages are archived.

## Quick start

```bash
python3 server.py --no-open --port 8097
# open http://127.0.0.1:8097/elysium-lp/
```

No third-party Python packages are required. The ethers.js browser bundle is vendored under `public/vendor/`.

## Configuration

Edit `config.json`:

- `network.rpcUrls`: Elysium RPCs, official first, fallback second.
- `uniswap`: public V4 contracts, PoolId and PoolKey.
- `ui.defaultAddress`: leave empty to connect a wallet; set an address for mobile read-only mode.
- `safety`: stale thresholds and limits.

Never put private keys, API tokens or personal server details in this file.

## Data notes

- Positions are enumerated from PositionManager `Transfer` logs and filtered with `ownerOf`.
- V4 position key must be packed:
  `keccak256(abi.encodePacked(positionManager, int24 tickLower, int24 tickUpper, bytes32 tokenId))`
- Pending fees:
  `liquidity * (feeGrowthInside - feeGrowthInsideLast) >> 128`
- Entry value uses the mint block's `getSlot0` + `getPositionLiquidity`, with HYPE historical 1h candles from Hyperliquid.
- KNTQ/USDT is derived from the KNTQ/HYPE pool price multiplied by HYPE/USDT. It is not a separate KNTQ/USDT pool.
- Liquidity distribution uses `StateView.getTickBitmap` + `getTickLiquidity`.

## Optional hourly Bark report

```bash
export BARK_KEY="your-bark-key"
export DEFAULT_ADDRESS="0x..."
node scripts/hourly_report.js
```

`isArchive: 1` keeps the notification in Bark history. The script is read-only.

## Limitations

- Single pool: KNTQ/HYPE.
- PnL includes pending fees, not already-claimed fees.
- Entry value is approximate if liquidity was added after mint.
- Read-only; add liquidity with another tool.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Not financial advice.
