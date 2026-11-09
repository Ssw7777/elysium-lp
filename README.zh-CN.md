# Elysium LP Dashboard · 中文

**Elysium 主网（chainId 99901）KNTQ/HYPE Uniswap V4** 流动性看板。链上数据只读；领取手续费或撤池时由浏览器钱包签名，服务端不接触私钥。

## 功能

- 读取真实 V4 池状态、仓位、tick 与流动性分布。
- 投入价值、目前价值、净 PnL、无常损失（IL）、待领手续费、**已领取手续费**。
- 已领取手续费**继续计入 PnL**，直到可选销毁空 NFT；普通 100% 撤池不会清除。仓位卡显示累计已领 USD。
- 5m / 30m / 1h 年化、未来 1 天预估收益；价格/估值 20 秒刷新，完整仓位扫描 60 秒。
- Uniswap 风格 KNTQ/USDT 流动性分布、当前价高亮、统计卡和主要区间表。
- 顶部提供 KNTQ/USDT 的 OKX K 线直达链接；OKX 禁止 iframe（`X-Frame-Options: DENY`），因此新标签页打开。
- 底部 HYPE 本位小窗口：Elysium 钱包 + LP 本金折合 + HyperEVM 钱包，可选参考 HYPE 数量。
- 添加流动性面板：任意一侧自由输入、自动配比、±2/±5/±10/±25/±50/全范围/自定义、滑点预览、Permit2 授权和 V4 mint；钱包余额自动刷新。
- 顶部吸顶导航、±2/5/10% 区间 APR 估算、5m–24h 成交量/手续费、只读观察地址仓位。
- 可选浏览器钱包模式：领取手续费 / 撤池；支持 OKX 内置 Elysium 网络，不在 OKX 里自动新增自定义网络。
- 每 15 秒检查 PositionManager `balanceOf`，发现新仓位后立即重新读取日志。
- 可选 Bark 定时报告：待领手续费、净 PnL、已领手续费、区间距离、HYPE 合计和时间。
- 只使用 Elysium 官方 RPC，不配置第三方备用 RPC。

## 只读与签名

服务端不会索要助记词或私钥，也不会广播交易。只有领取手续费、撤池和添加流动性时，浏览器钱包才会签名。没有自动放宽滑点、自动重发或私钥处理。

默认 `ui.defaultAddress` 为空，页面进入连接钱包模式；只有想做手机只读看板时才填入公开地址。

## 快速开始

```bash
git clone https://github.com/Ssw7777/elysium-lp.git
cd elysium-lp
python3 server.py --no-open --port 8097
# 打开 http://127.0.0.1:8097/elysium-lp/
```

无需第三方 Python 包；ethers.js 已放在 `public/vendor/`。

## 配置

编辑 `config.json`：

- `network.rpcUrls`：只填 Elysium 官方 RPC。
- `uniswap.*`：公开的 V4 池、PoolManager、StateView、PositionManager 地址。
- `ui.defaultAddress`：留空则连接钱包；填地址则只读查看。
- `ui.hypeReference`：仅作为 HYPE 小窗口的参考数量；填 `0` 隐藏参考。
- `ui.hyperEvmRpc`：读取 HyperEVM 钱包 HYPE 的 RPC。
- `safety.*`：过期阈值和显示限制。

不要在这个文件里写私钥、交易所 API key、Bark key 或个人服务器信息。

## 已领手续费记录

领取交易确认后，前端会把 owner、tokenId、领取的 HYPE/KNTQ、USD 估值和交易哈希提交到 `POST /api/claim`，服务端写入：

```text
~/.elysium-lp-claims.json
```

`GET /api/claims?owner=0x...` 读取记录。记录只在可选销毁空 NFT 时通过 `POST /api/claim/clear` 删除；普通 100% 撤池会保留，已领手续费继续计入 PnL。

PnL 口径：

```text
本金 + 待领手续费 + 累计已领手续费 - 建仓价值
```

这个 journal 本身不含密钥，但仍是私人数据。**把服务放到公网前，务必套一层认证（例如 Caddy `forward_auth`）**，不要把 `/api/claim` 暴露成无认证写接口。

## 可选 Bark 定时报告

`scripts/hourly_report.js` 是可选只读 Node.js 任务。为了兼容保留了文件名；可以按任意间隔运行，例如每 5 分钟：

```bash
export BARK_KEY="你的 Bark key"
export DEFAULT_ADDRESS="0x..."
node scripts/hourly_report.js
```

消息包含待领手续费、净 PnL、已领手续费、区间距离、HYPE 合计和时间。`isArchive: 1` 会保留历史；脚本只读链上数据。

systemd 可用 `OnCalendar=*:0/5` 实现 5 分钟一次。`BARK_KEY` 放在权限 `600` 的 `EnvironmentFile` 里，不要提交到仓库。

### Bark 提醒

5 分钟报表会用**当次新鲜读取的当前仓位**判断：

- **出区间**：活动仓位离开区间时提醒；持续在区间外最多每 30 分钟重复一次；回到区间、撤池、销毁或流动性归零后清除状态。
- **5m 年化 > 20,000%**：5 分钟 fee growth 年化越过阈值时提醒；持续超过最多每 30 分钟重复一次。
- 仓位读取不完整时跳过提醒，不会用旧范围误报；提醒状态保存在仓库外的私有文件。

## 数据口径

- 仓位：从 PositionManager `Transfer` 日志枚举，`ownerOf` 过滤；用 `balanceOf` 快速发现新仓位。
- V4 position key：
  `keccak256(abi.encodePacked(positionManager, int24 tickLower, int24 tickUpper, bytes32 tokenId))`
- 待领手续费：
  `liquidity * (feeGrowthInside - feeGrowthInsideLast) >> 128`
- 投入价值：建仓区块的 `getSlot0` + `getPositionLiquidity`，HYPE 历史价用 Hyperliquid 1h K 线。
- KNTQ/USDT 由 KNTQ/HYPE 池价 × HYPE/USDT 折算，不是独立 KNTQ/USDT 池。
- 流动性分布：`StateView.getTickBitmap` + `getTickLiquidity`。
- HYPE 合计 = Elysium 钱包（HYPE + 钱包 KNTQ 折合）+ LP 现值（本金 + 待领手续费）+ HyperEVM（chain 999）钱包 HYPE。已领手续费已在钱包里。

## 限制

- 只做 KNTQ/HYPE 单池。
- 已内置添加流动性面板；没有自动 swap、自动调仓或自动重发交易。
- 建仓后加过流动性时，投入价值为估算。
- 已领记录从本功能上线后开始保存；直接在其他钱包操作或上线前的领取不会自动回溯。
- HYPE/USD、KNTQ/USD 是行情估算，不保证成交价。

## 许可

MIT，见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。不构成投资建议。
