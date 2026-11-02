#!/usr/bin/env node
/**
 * 29-backfill-state.js — 把已执行计划的判定补写进 state.jsonl（只追加）
 *
 * 为什么需要它（2026-10-31 实测）：
 *   视频号助手侧边栏已改成「只有图标」，评论页 DOM 里读不到当前账号名
 *   （`.account-info` 只剩「切换视频号/取消切换」，没有昵称），
 *   于是 `26-whoami.js` 在评论页返回空 → `13` 打「未识别当前账号，本次不写 state」。
 *   回复照发，但 skip/reply 没落库，`25-open-items` 下次还会把它们当待处理。
 *   本脚本用 `--account` 显式指定账号，按计划文件补写同一批 state（幂等性由 fp 去重保证：
 *   同一条评论重复补写只会让最后一条生效，不会影响判定结果）。
 *
 * 用法：
 *   node scripts\29-backfill-state.js --account mingge-jg --plan .\data\reply\plan-nth6.json
 *   node scripts\29-backfill-state.js --account mingge-jg --plan .\data\reply\plan-nth6.json --dry
 *
 * 注意：只在「13 已发送/已校验、但提示未写 state」时使用；不要用它替代正常发送流程。
 */

const fs = require("fs");
const path = require("path");
const store = require("./lib/store");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const ACCOUNT = getArg("account");
const PLAN = getArg("plan");
const DRY = has("dry");

if (!ACCOUNT || !PLAN) {
  console.error("用法: node scripts\\29-backfill-state.js --account <id> --plan <plan.json> [--dry]");
  process.exit(1);
}
if (!store.readAccount(ACCOUNT)) {
  console.error(`[失败] 账号 ${ACCOUNT} 未注册（缺 data/accounts/${ACCOUNT}/account.json）`);
  process.exit(3);
}

const plan = JSON.parse(fs.readFileSync(PLAN, "utf8"));
const pt = store.publishKey(plan.video);
if (!pt) {
  console.error("[失败] 计划缺少可解析的发布时间（plan.video.time）");
  process.exit(1);
}

const decided = plan.items.filter((x) => x.action === "reply" || x.action === "skip");
if (!decided.length) {
  console.log("计划里没有已决条目（action=reply/skip），无需补写");
  process.exit(0);
}

const source = path.basename(PLAN);
const rows = decided.map((x) => ({
  fp: store.commentFp({ author: x.name, time: x.time }),
  author: x.name,
  time: x.time,
  action: x.action,
  text: x.action === "reply" ? x.text : "",
  reason: x.reason || "",
  source,
  at: new Date().toISOString(),
}));

console.log(`账号 ${ACCOUNT}｜视频 ${pt}｜补写 ${rows.length} 条（reply ${rows.filter((r) => r.action === "reply").length} / skip ${rows.filter((r) => r.action === "skip").length}）`);
if (DRY) {
  for (const r of rows) console.log(`  [dry] ${r.action} ${r.author} ${r.time}`);
  process.exit(0);
}
store.appendState(ACCOUNT, pt, rows);
console.log(`✓ 已写入 data/accounts/${ACCOUNT}/v/${pt}/state.jsonl`);
