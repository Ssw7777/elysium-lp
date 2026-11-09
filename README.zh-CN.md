# Elysium LP Dashboard · 中文

只读的 **Elysium 主网（chainId 99901）KNTQ/HYPE Uniswap V4** 流动性看板。不托管私钥，不发交易。

## 功能

- 读取真实 V4 池状态与钱包 NFT 仓位。
- 投入时价值、目前价值、净 PnL、无常损失（IL）、待领手续费。
- 5m / 30m / 1h 年化，未来 1 天预估收益。
- Uniswap 风格流动性分布：KNTQ/USDT 价格柱状图、当前价高亮、统计卡、主要区间表。
- 仓位区间距离、持仓时长、建仓时价格。
- 手机只读模式：在 `config.json` 的 `ui.defaultAddress` 填入地址，无需连接钱包。
- 可选 Bark 小时报：待领手续费 + 净 PnL + 区间距离，消息保留。

## 快速开始

```bash
python3 server.py --no-open --port 8097
# 打开 http://127.0.0.1:8097/elysium-lp/
```

无需安装第三方 Python 包；浏览器用的 ethers.js 已放在 `public/vendor/`。

## 配置

编辑 `config.json`：

- `network.rpcUrls`：Elysium RPC，官方优先，备用第二。
- `uniswap`：公开的 V4 合约、PoolId、PoolKey。
- `ui.defaultAddress`：留空则连接钱包；填地址则移动端只读。
- `safety`：过期阈值等。

不要在这个文件里写私钥、API token、个人服务器信息。

## 数据口径

- 仓位：从 PositionManager `Transfer` 日志枚举，`ownerOf` 过滤。
- V4 position key 必须 packed：
  `keccak256(abi.encodePacked(positionManager, int24 tickLower, int24 tickUpper, bytes32 tokenId))`
- 待领手续费：
  `liquidity * (feeGrowthInside - feeGrowthInsideLast) >> 128`
- 投入价值：建仓区块的 `getSlot0` + `getPositionLiquidity`，HYPE 历史价用 Hyperliquid 1h K 线。
- KNTQ/USDT 由 KNTQ/HYPE 池价 × HYPE/USDT 折算，不是独立 KNTQ/USDT 池。
- 流动性分布：`StateView.getTickBitmap` + `getTickLiquidity`。

## 可选 Bark 小时报

```bash
export BARK_KEY="你的 Bark key"
export DEFAULT_ADDRESS="0x..."
node scripts/hourly_report.js
```

`isArchive: 1` 会保留消息历史；脚本只读链上数据。

## 限制

- 只做 KNTQ/HYPE 单池。
- PnL 只含待领手续费，不含已领取。
- 建仓后加过流动性时，投入价值为估算。
- 只读；添加流动性请用其他工具。

## 许可

MIT，见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。不构成投资建议。
