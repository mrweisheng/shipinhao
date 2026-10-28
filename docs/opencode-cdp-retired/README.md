# OpenCode / CDP 方案归档说明（已退役）

> 归档时间：2026-10-28（分支 `doubao-port` 改造时）
> 这些文件是原「OpenCode + 独立 Chrome + CDP 9222」方案的浏览器驱动层，
> 已由**豆包工作助手内置浏览器**替代，**不再使用、不再维护**。
> 归档仅作历史参考（页面结构知识、判据逻辑可对照），如要恢复原方案，回退到 `main` 分支即可。

## 退役了什么

| 类别 | 文件 |
|---|---|
| 浏览器启动/登录 | `01-launch-chrome.js`、`01-launch-clean-chrome.ps1`、`02-watch-login.js` |
| 页面导航/操作 | `03-open-comments.js`、`04-list-videos.js`、`05-open-video.js`、`06-extract-comments.js`、`07-read-video.js` |
| 回复/点赞/自测 | `08-reply-comment.js`、`09-selftest.js`、`10-like-comment.js`、`13-execute-plan.js`、`24-sweep-account.js`、`26-whoami.js` |
| CDP 库与动作库 | `lib/cdp.js`、`lib/channels.js`、`lib/login.js`、`lib/nav.js`、`lib/ui.js` |
| 诊断工具 | 全部 `probe-*.js`、`cdp-click.js`、`cdp-eval.js`、`analyze-comment-api.js`、`capture-window.js`、`capture-window.ps1` |

## 对应关系（新方案怎么做）

| 旧脚本 | 新方案（豆包内置浏览器） |
|---|---|
| 01/02/26 | 内置浏览器登录 + shadowRoot 内搜账号名核对 |
| 03/04/05 | 标题关键词定位列表项 → 坐标点击 → 核对详情头 |
| 06/07 | 模型滚动+展开折叠+声明数对账（判据不变） |
| 08/10/13 | 模型按《豆包内置浏览器操作手册》§2.6/§2.7 执行 + 三信号核验 + 点赞 |
| 24 | 模型遍历视频列表写入 `data/accounts/`（结构不变） |
| probe-* | 页面结构稳定期不需要；改版时按《页面结构与操作点.md》第 7 节排查 |

## 仍保留的纯数据脚本（Node 直接跑，不碰浏览器）

`scripts/11-pick-template.js`、`12-prepare-plan.js`、`15-case-library.js`、`16-build-eval-set.js`、
`17-novelty-scan.js`、`18-build-blind-pack.js`、`19-build-blind-judge.js`、`20-score-blind.js`、
`21-build-human-spotcheck.js`、`22-diff-snapshots.js`、`25-open-items.js`
及 `scripts/lib/` 下 `case-library.js`、`layout-map.js`（页面结构知识表）、`plan.js`、`store.js`、`template-pool.js`。
