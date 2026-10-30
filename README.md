# 视频号评论区维护

微信视频号助手（channels.weixin.qq.com）评论区维护：读评论、判断作者是否已回、按策略生成回复、三信号核验、点赞、登记。

## 两个分支

| 分支 | 说明 |
|---|---|
| **main**（默认） | OpenCode + 独立 Chrome + CDP 方案，已验证稳定版（历史基线） |
| **doubao-port**（当前） | **豆包工作助手内置浏览器版**：同一客户端内完成全部页面操作 |

> **回复策略两分支完全同源**：`SKILL.md`、`業務事實.md`、`模板池.md`、`scripts/lib/plan.js` 两分支同一份内容；
> 策略变更（判断、话术、配额、核验判据）**必须同时进两个分支**，只有浏览器执行层不同。
> 日常维护请用 `doubao-port`。回退原方案：切回 `main` 分支即可。

## 每天开工先读这 4 个

1. `.opencode/skills/channels-comment-ops/SKILL.md` — 判断规则（回不回、话术、红线、点赞）
2. `业务事实.md` — 回复口径（分期、车况、库存、时间、地址、包牌税险、移民、求职）
3. `豆包内置浏览器操作手册.md` — **页面操作怎么做**（内置浏览器）
4. `每次必做核验清单.md` — 每条回复前后逐项核验的关卡

## 规则权威

| 层 | 文件 | 作用 |
|---|---|---|
| 事实 | `业务事实.md` | 唯一事实来源：价格 / 付款 / 车况 / 地址 / 移民 / 求职口径 |
| 判断 | `.opencode/skills/channels-comment-ops/SKILL.md` | 回不回、动作分类、硬规则、红线 |
| 参考 | `data/cases/`（`seed.jsonl` + `cases.jsonl`） | **主参考**：检索 2 条好案例 + 1 条坏案例 → 仿写 |
| 变体 | `模板池.md` | 仅 `GUIDE-*` 引导尾巴（155 条）与兜底候选 |

冲突时：**业务事实 → SKILL → 案例库 → 模板池**。

> 旧的「话术库 / 规则总纲」目录已废弃，磁盘上不存在；三轮盲评显示案例库生成 96% 胜模板池，见 `docs/盲评报告-第二轮.md`。

## 根目录文件

| 文件 | 用途 |
|---|---|
| `SKILL.md`（在 `.opencode/skills/`） | 判断规则入口 |
| `业务事实.md` | 回复口径，唯一来源 |
| `data/cases/` | 案例库（seed + 自动入库），生成时主参考 |
| `模板池.md` | 仅引导尾巴与兜底候选；`11-pick-template` 直接读 |
| `豆包内置浏览器操作手册.md` | 豆包内置浏览器版操作手册（当前方案） |
| `每次必做核验清单.md` | 逐项核验关卡（替代原退出码） |
| `操作手册.md` | OpenCode 旧方案手册（仅供对照，浏览器命令已退役） |
| `页面结构与操作点.md` | 页面结构、选择器、改版排查 |
| `执行记录.md` | 每个视频的批次快照（人工摘要） |
| `docs/opencode-cdp-retired/` | 退役的 OpenCode/CDP 浏览器层（归档参考） |

## 常用命令（仅纯数据脚本，不碰浏览器）

```powershell
# 今天该处理哪几条（先跑这个，列出待处理清单）
node scripts\25-open-items.js --account mingge-yg --max-video-age 45

# 生成待判断清单（读本地数据）
node scripts\12-prepare-plan.js --nth 5

# 案例库
node scripts\15-case-library.js --stats
node scripts\15-case-library.js --search "司分期付款嗎" --intent car_payment --top 5

# 语料候选 / 校验语料池
node scripts\11-pick-template.js --category CAR-STOCK --count 5
node scripts\11-pick-template.js --validate
```

**页面操作（读评论/判已回/回复/点赞/展开折叠/账号切换）全部在豆包内置浏览器里由模型执行**，
流程见《豆包内置浏览器操作手册.md》，判据与关卡见《每次必做核验清单.md》。

## 数据

- `data/account-new/`、`data/maintain/` — 每条视频的评论 JSON
- `data/reply/` — 发送记录、计划、复核
- `data/cases/` — 案例库（seed + 自动入库 + novel queue）
- `data/eval/` — 盲评数据与报告

## 历史 / 调研 / 评测

都在 `docs/`，平时不用看，复盘时查：

- `docs/试验记录.md` — 实测数据、被吞、-4010、盲评等教训
- `docs/调研-浏览器选型.md` — 为什么不用 Playwright / 强制直连（OpenCode 方案选型背景）
- `docs/调研-回复方式.md` — 为什么用 CDP / 为什么不走接口（背景参考）
- `docs/盲评报告.md`、`docs/盲评报告-第二轮.md` — 模板 vs 案例库盲评
