# channels-comment-ops — 通用技能包安装指南

本目录是一个符合 **Agent Skills 通用规范** 的自包含技能包。`SKILL.md` 内引用的规则文件全部在
本目录内（`references/`、`docs/`，相对路径），所以可以**整体复制**到任意支持该规范的 AI 助手，
复制后无需修改任何路径。

## 一、安装到各 AI 助手

把整个 `channels-comment-ops` 文件夹复制到对应助手的 skills 目录：

| AI 助手 | 放置位置（Windows 本机示例） |
|---|---|
| Claude Code | 项目级 `C:\Users\Administrator\Desktop\视频号\.claude\skills\channels-comment-ops\`<br>或用户级 `C:\Users\Administrator\.claude\skills\channels-comment-ops\` |
| OpenCode | 项目级 `C:\Users\Administrator\Desktop\视频号\.opencode\skills\channels-comment-ops\`<br>或用户级 `C:\Users\Administrator\.opencode\skills\channels-comment-ops\` |
| Cursor | `C:\Users\Administrator\Desktop\视频号\.cursor\skills\channels-comment-ops\` |
| Codex | `C:\Users\Administrator\.codex\skills\channels-comment-ops\` |
| 豆包助手 | 技能根目录（`workspace\.skills\` / `.user_skills\` / `C:\Users\Administrator\Doubao\skills\`）之一 |

> 判断助手是否支持：只要它按"`skills/<技能名>/SKILL.md` + YAML frontmatter（name / description）"
> 的约定发现技能，就支持本技能包。

## 二、运行时前置条件（必须满足，否则脚本跑不起来）

技能规则是自包含的，但**执行**依赖这台机器的"视频号项目运行时"，这是不可移植的外部依赖：

| 依赖 | 说明 |
|---|---|
| 项目根 | `C:\Users\Administrator\Desktop\视频号`（脚本、数据、页面结构文档都在这里） |
| Chrome + CDP | 有头 Chrome 启动 9222 调试端口，直连（`--no-proxy-server`），无 `webdriver` 标记 |
| 登录态 | 视频号助手后台保持登录；`profile\` 目录存有 Chrome 登录态，过期需扫码 |
| Node.js | 所有 `scripts\*.js` 依赖 node 运行 |
| 运行时文件 | `业务事实.md`（口径唯一来源）、`模板池.md`（语料）、`页面结构与操作点.md`（选择器）、`操作手册.md`（排查） |

**所有脚本命令都以项目根为工作目录执行**（先 `cd C:\Users\Administrator\Desktop\视频号`）。
技能包内 `references/`、`docs/` 是规则与经验，脚本**不读**技能包内文件。

## 三、安装后验证

1. 助手能发现技能：对助手说「维护评论区 / 回复评论 / 处理评论」，能触发本技能。
2. 规则可读：让助手读 `SKILL.md` 第 0 节提到的 `references/00-规则总纲.md`，路径能解析。
3. 运行时就绪：在项目根跑 `node scripts\07-read-video.js --nth 1 --json .\data\login-check.json`，
   退出码 0 说明 Chrome/CDP/登录态正常。

## 四、维护与同步（重要）

- **主版本**在本目录：`C:\Users\Administrator\Desktop\视频号\skills\channels-comment-ops\`
  —— 修改规则/技能时改这里。
- **OpenCode 副本**：`C:\Users\Administrator\Desktop\视频号\.opencode\skills\channels-comment-ops\`
  —— 与主版本内容一致，供 OpenCode 直接加载。改完主版本后，把 `SKILL.md`、`references\`、`docs\`
  重新复制过去保持同步。
- **D 盘旧权威**：`D:\视频号\视频号评论区维护\references\`（00–03 四个文件）已复制进本包，
  D 盘保留为历史备份，不再作为运行源；确认无引用后可自行归档。
- **执行记录**：每次任务收尾追加写 `references/03-执行记录.md`（本包内）。
