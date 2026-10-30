# 视频号评论区维护

微信视频号助手（channels.weixin.qq.com）评论区维护工具：读评论、判断作者是否已回、按策略生成回复、三信号核验、点赞、登记。

> **回复策略与 `doubao-port` 分支完全同源**：`SKILL.md`、`业务事实.md`、`模板池.md`、`scripts/lib/plan.js` 两分支同一份内容。
> 策略变更（判断、话术、配额、核验判据）必须同时进两个分支；本分支只保留 OpenCode + Chrome 执行层。
> 当前执行期三铁律：先展开再判已回 / 先看红灰再点赞 / 按时间增量（`scripts/28-diff-comments.js`）。

## 每天开工先读这 3 个

1. `.opencode/skills/channels-comment-ops/SKILL.md` — 执行入口（流程、硬规则、命令）
2. `业务事实.md` — 回复口径（分期、车况、库存、时间、地址、包牌税险、移民、求职）
3. `操作手册.md` — 命令、退出码、故障排查

## 规则权威

| 层 | 文件 | 作用 |
|---|---|---|
| 事实 | `业务事实.md` | 唯一事实来源：价格 / 付款 / 车况 / 地址 / 移民 / 求职口径 |
| 判断 | `.opencode/skills/channels-comment-ops/SKILL.md` | 回不回、动作分类、硬规则、红线 |
| 参考 | `data/cases/`（`seed.jsonl` + `cases.jsonl`） | **主参考**：检索 2 条好案例 + 1 条坏案例 → 仿写 |
| 变体 | `模板池.md` | 仅 `GUIDE-*` 引导尾巴（155 条）与兜底候选 |

冲突时：**业务事实 → SKILL → 案例库 → 模板池**。

> 旧的「话术库 / 规则总纲」目录（`视频号评论区维护\references\`）已废弃，磁盘上也不存在。
> 三轮盲评显示案例库生成 96% 胜模板池，原因见 `docs/盲评报告-第二轮.md`。

## 根目录文件

| 文件 | 用途 |
|---|---|
| `SKILL.md`（在 `.opencode/skills/`） | 执行入口 |
| `业务事实.md` | 回复口径，唯一来源 |
| `data/cases/` | 案例库（`seed.jsonl` 种子 + `cases.jsonl` 自动入库），生成时主参考 |
| `模板池.md` | 仅引导尾巴与兜底候选；`11-pick-template` 直接读 |
| `操作手册.md` | 怎么跑 |
| `页面结构与操作点.md` | 页面结构、选择器、改版排查 |
| `执行记录.md` | 每个视频的批次快照（人工摘要） |

## 历史 / 调研 / 评测

都在 `docs/`，平时不用看，复盘时查：

- `docs/试验记录.md` — 实测数据、被吞、-4010、盲评等教训
- `docs/调研-浏览器选型.md` — 为什么不用 Playwright / 强制直连
- `docs/调研-回复方式.md` — 为什么用 CDP / 为什么不走接口
- `docs/盲评报告.md`、`docs/盲评报告-第二轮.md` — 模板 vs 案例库盲评

## 常用命令

```powershell
cd D:\视频号

# 0. 启动浏览器 + 确认当前账号（同一时刻只有账号在线）
node scripts\01-launch-chrome.js
node scripts\26-whoami.js

# 今天该处理哪几条（不碰浏览器）
node scripts\25-open-items.js --account mingge-yg --max-video-age 45

# 读第 N 条 + 生成待判断清单
node scripts\12-prepare-plan.js --nth 5

# 校验 / 试运行 / 发送
node scripts\13-execute-plan.js --plan .\data\reply\plan-nth5.json
node scripts\13-execute-plan.js --plan .\data\reply\plan-nth5.json --rehearse
node scripts\13-execute-plan.js --plan .\data\reply\plan-nth5.json --send

# 案例库
node scripts\15-case-library.js --stats
node scripts\15-case-library.js --search "司分期付款嗎" --intent car_payment --top 5
```

## 数据

- `data/account-new/`、`data/maintain/` — 每条视频的评论 JSON
- `data/reply/` — 发送记录、计划、复核
- `data/cases/` — 案例库（seed + 自动入库 + novel queue）
- `data/eval/` — 盲评数据与报告
