# 视频号评论区维护

微信视频号助手（channels.weixin.qq.com）评论区维护工具：读评论、判断作者是否已回、按策略生成回复、三信号核验、点赞、登记。

> 只有一个分支：`main`。旧的 `doubao-port` 已封存，不再同步。
> 执行期三铁律：先展开再判已回 / 先看红灰再点赞 / 按时间增量（`scripts/28-diff-comments.js`）。

## 每天开工先读这 3 个

1. `.opencode/skills/channels-comment-ops/SKILL.md` — 执行入口（流程、硬规则、命令）
2. `业务事实.md` — 回复口径（价格、付款、车况、库存、地址、两地牌、移民、求职）
3. `操作手册.md` — 命令、退出码、故障排查

## 规则权威

| 层 | 文件 | 作用 |
|---|---|---|
| 事实 | `业务事实.md` | 唯一事实来源；冲突时以它为准 |
| 判断 | `.opencode/skills/channels-comment-ops/SKILL.md` | 回不回、动作分类、红线 |
| 参考 | `data/cases/`（`seed.jsonl` + `cases.jsonl`） | **主参考**：检索 2 条好案例 + 1 条坏案例 → 仿写 |
| 变体 | `模板池.md` | 直接答句 + 场景话术（原 01）+ 兜底候选（200 条），`11-pick-template` 直接读 |
| 操作 | `操作手册.md` | 怎么跑；附录 A 页面结构、附录 B 技术实现 |

冲突时：**业务事实 → SKILL → 案例库 → 模板池**。

> 回复口径两条底线：
> 1. **平台内联系动作零容忍**：不点头像、不给主页/简介、不私信。
> 2. **线下动作按业务给**：车 `現場睇`；两地牌/移民 `嚟公司傾`；地址、时间、导航随时给。

## 根目录文件

| 文件 | 用途 |
|---|---|
| `业务事实.md` | 回复口径，唯一来源 |
| `操作手册.md` | 怎么跑、退出码、排查 |
| `执行记录.md` | 每个视频的批次快照（人工摘要） |
| `模板池.md` | 直接答句与兜底候选 |
| `data/leads/leads.html` | 重点线索（问联系方式 / 问价格），每批自动更新，人工私下跟进 |
| `README.md` | 本文件：入口与文档地图 |

## 历史 / 调研 / 评测

都在 `docs/`，平时不用看，复盘时查：

- `docs/试验记录.md` — 实测数据、被吞、-4010、盲评等教训
- `docs/调研-浏览器选型.md` — 为什么不用 Playwright / 强制直连
- `docs/调研-回复方式.md` — 为什么用 CDP / 为什么不走接口
- `docs/盲评报告.md`、`docs/盲评报告-第二轮.md` — 模板 vs 案例库盲评
- 页面结构、选择器、技术实现：见 `操作手册.md` 附录 A / B

## 常用命令

```powershell
cd D:\视频号

# 0. 启动浏览器 + 确认当前账号（同一时刻只有账号在线）
node scripts\01-launch-chrome.js
node scripts\26-whoami.js

# 今天该处理哪几条（不碰浏览器）
node scripts\25-open-items.js --account mingge-yg --max-video-age 30

# 读第 N 条 + 生成待判断清单
node scripts\12-prepare-plan.js --nth 5

# 校验 / 试运行 / 发送
node scripts\13-execute-plan.js --plan .\data\reply\plan-nth5.json
node scripts\13-execute-plan.js --plan .\data\reply\plan-nth5.json --rehearse
node scripts\13-execute-plan.js --plan .\data\reply\plan-nth5.json --send

# 案例库
node scripts\15-case-library.js --stats
node scripts\15-case-library.js --search "司分期付款嗎" --intent car_payment --top 5
node scripts\30-audit-cases.js            # 旧口径复审（加 --apply 落库）
```

## 数据

- `data/accounts/` — 每个账号、每条视频的 `latest.json` + `state.jsonl`（增量依据）
- `data/reply/` — 计划、发送记录、复核
- `data/cases/` — 案例库（seed + 自动入库 + novel queue）
- `data/eval/` — 盲评数据与报告
- `data/_archive/` — 一次性快照（不参与运行）
