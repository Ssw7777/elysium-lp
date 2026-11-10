# Elysium LP Dashboard · 中文

**Elysium 主网（chainId 99901）KNTQ/HYPE Uniswap V4** 流动性看板。链上数据只读；领取手续费或撤池时由浏览器钱包签名，服务端不接触私钥。

## 功能

- 读取真实 V4 池状态、仓位、tick 与流动性分布。
- 两个官方 KNTQ/HYPE Uniswap V4 池：**1%**（`fee` 10000，`tickSpacing` 200，poolId `0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac`）和 **0.3%**（`fee` 3000，`tickSpacing` 60，hooks `0`，poolId `0xf9b8a9101438145d62c9f03156b203c6c573931167e2d36f9061a32575706c8a`）。行情、分布和添加流动性可以切换费率；汇总始终包含两个池，每个 NFT 用自己的 poolKey 计价。
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

默认 `ui.defaultAddress` 为空，页面进入连接钱包模式，并提示如何连接或在本地填写地址。`ui.hypeReference` 在仓库里保持 `0`。只有做手机只读看板时，才在不提交的本地配置里填写公开地址。

## 快速开始

```bash
git clone https://github.com/Ssw7777/elysium-lp-26-11-9.git
cd elysium-lp
python3 server.py --no-open --port 8097
# 打开 http://127.0.0.1:8097/elysium-lp/
```

无需第三方 Python 包；ethers.js 已放在 `public/vendor/`。

## 配置

编辑 `config.json`：

- `network.rpcUrls`：只填 Elysium 官方 RPC。
- `uniswap.*` 与 `uniswap.pools`：公开的 PoolManager、StateView、PositionManager，以及上面两个池。`uniswap.poolId` 是默认的 1% 视图。
- `ui.defaultAddress`：仓库里保持 `""`。页面会提示连接钱包；只读地址只写在不提交的本地配置里。
- `ui.hypeReference`：仓库里保持 `0`，不要写入个人资金 baseline。
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

`report.js` 是可选只读 Node.js 任务。它覆盖配置里的两个池，每个 NFT 用自己的 poolKey 计价，对瞬时 RPC 失败重试，并在已知活跃仓位既未确认关闭、也未完整读到时拒绝发送，避免半份报告。

```bash
export BARK_KEY="你的 Bark key"
export DEFAULT_ADDRESS="0xYourPublicAddress"
node report.js
```

`scripts/hourly_report.js` 只是把同一次任务转发给 `report.js`，不要和 `report.js` 同时挂定时器。未配置钱包时，脚本会直接说明如何设置 `DEFAULT_ADDRESS`，不会访问 RPC，也不会把这次配置缺口当成故障推送。

消息包含待领手续费、净 PnL、已领手续费、区间距离、HYPE 合计和时间。`isArchive: 1` 会保留历史；脚本只读链上数据。

示例单元在 `deploy/`。仓库不会替你开启 GitHub Actions 或定时任务。若自行安装，`OnCalendar=*:0/5` 是 5 分钟一次。`BARK_KEY` 放在权限 `600` 或 `640` 的 `EnvironmentFile` 里，不要提交到仓库。

### Bark 提醒

5 分钟报表会用**当次新鲜读取的当前仓位**判断：

- **出区间**：活动仓位离开区间时提醒；持续在区间外最多每 30 分钟重复一次；回到区间、撤池、销毁或流动性归零后清除状态。
- **5m 年化 > 20,000%**：5 分钟 fee growth 年化越过阈值时提醒；持续超过最多每 30 分钟重复一次。
- 仓位读取不完整时跳过提醒，不会用旧范围误报。所有 LP 仓位清空后发送一次 **“Elysium LP 已清空”** 并暂停定时报表；检测到新仓位后自动恢复。提醒状态保存在仓库外的私有文件。

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

- 只做上面的 KNTQ/HYPE 1% 与 0.3% 两个池，不包含其他交易对。
- 已内置添加流动性面板；没有自动 swap、自动调仓或自动重发交易。
- 建仓后加过流动性时，投入价值为估算。
- 已领记录从本功能上线后开始保存；直接在其他钱包操作或上线前的领取不会自动回溯。
- HYPE/USD、KNTQ/USD 是行情估算，不保证成交价。

## 安全部署

- `server.py` 只监听 `127.0.0.1`，前面用你自己的反向代理，并先加上登录认证。不要把 8097 暴露到公网。
- 不要提交钱包、Bark 设备 key、领取记录、提醒状态、HYPE baseline 或 NFT 列表。这些运行时文件已在 `.gitignore`；示例只在 `deploy/*.example`。
- `deploy_vps.sh` 只有在 `ELYSIUM_INSTALL=1` 时才安装本机 Web 服务，并且不会安装 Bark timer。
- 本仓库不包含另一套登录项目。生产环境的反代配置和 EnvironmentFile 不要放进 git。
- `config.json` 里只保留公开合约地址和两个 poolId。

## 许可

MIT，见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。不构成投资建议。
