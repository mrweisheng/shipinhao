#!/usr/bin/env node
/**
 * 25-open-items.js — 从新存储里列出「还没回」的评论（只读）
 *
 * 不抓浏览器，只读本地快照；配合 24-sweep-account.js 使用。
 *
 * 用法：
 *   node scripts/25-open-items.js --account mingge-yg
 *   node scripts/25-open-items.js --account mingge-yg --days 14        # 只看近 14 天的评论
 *   node scripts/25-open-items.js --account mingge-yg --growth         # 只看评论数增长过的视频
 *   node scripts/25-open-items.js --account mingge-yg --out .\data\open.md
 */

const fs = require("fs");
const path = require("path");
const store = require("./lib/store");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return d;
};
const has = (n) => argv.includes(`--${n}`);

const ACCOUNT = getArg("account");
if (!ACCOUNT) {
  console.error("需要 --account <id>");
  process.exit(1);
}
const DAYS = Number(getArg("days", "0"));
const MAX_VIDEO_AGE = Number(getArg("max-video-age", "45")); // 视频发布超过 N 天不做维护
const OUT = getArg("out");
const GROWTH = has("growth");
const ALL = has("all");

const acc = store.readAccount(ACCOUNT);
if (!acc) {
  console.error(`账号 ${ACCOUNT} 不存在：${store.accDir(ACCOUNT)}`);
  process.exit(1);
}

const cut = DAYS > 0 ? new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10) : null;
// 评论时间是 2026/10/28 10:37，统一成 2026-10-28 再比
const isoDate = (t) => String(t || "").replace(/\//g, "-").slice(0, 10);
const rows = store.readVideos(ACCOUNT);
let lines = [];
let totalOpen = 0;
let totalShown = 0;
let noSnapshot = 0;
let outOfWindow = 0;
let outOfWindowOpen = 0;

lines.push(`账号：${acc.displayName || acc.id}（${acc.id}）`);
lines.push(`视频 ${rows.length} 条｜筛选：${GROWTH ? "仅评论数增长" : "全部"}${cut ? `｜评论日期 ≥ ${cut}` : ""}`);
lines.push("");

for (const r of rows) {
  // 视频发布超过 N 天 → 整条不做维护（SKILL 第 3 节第 0 条）
  if (MAX_VIDEO_AGE > 0) {
    const ageCut = new Date(Date.now() - MAX_VIDEO_AGE * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
    if (String(r.publishTime).slice(0, 8) < ageCut) {
      outOfWindow++;
      outOfWindowOpen += (r.awaiting || 0);
      continue;
    }
  }
  const snap = store.readSnapshot(ACCOUNT, r.publishTime);
  if (!snap) {
    noSnapshot++;
    continue;
  }
  const state = store.readState(ACCOUNT, r.publishTime);
  const open = (snap.comments || []).filter(
    (c) => c.level === 1 && !c.authorReplied && !c.isAuthor && String(c.content || "").trim()
  );
  // 已决 = state 里判过 reply 或 skip。
  // reply 也要算已决：快照刷新前 authorReplied 还是 false，只看 skip 会把刚回过的条目
  // 继续当「待处理」报出来，容易重复回。
  const isDecided = (c) => {
    const st = state.get(store.commentFp(c));
    return !!st && (st.action === "skip" || st.action === "reply");
  };
  const decided = open.filter(isDecided);
  const pending = open.filter((c) => !isDecided(c));
  const recent = cut ? pending.filter((c) => isoDate(c.time) >= cut) : pending;
  const list = ALL ? pending : recent;
  if (!list.length) continue;
  if (GROWTH && !(r.commentCount > (r.prevCommentCount ?? r.commentCount))) continue;

  totalOpen += open.length;
  totalShown += list.length;
  lines.push(`## ${r.publishTime} ${String(r.title || "").split("#")[0].slice(0, 40)}`);
  lines.push(`   声明 ${r.declared}｜未回 ${open.length}（已判 skip ${decided.length}，待处理 ${pending.length}）｜增速 ${r.prevCommentCount == null ? "-" : r.commentCount - r.prevCommentCount}`);
  for (const c of list.slice(0, 40)) {
    lines.push(`   [${c.index}] ${String(c.author).replace(/\s+/g, " ")} ${c.time}: ${String(c.content).replace(/\s+/g, " ").slice(0, 80)}`);
  }
  if (list.length > 40) lines.push(`   … 还有 ${list.length - 40} 条`);
  lines.push("");
}

lines.push(`合计：未回 ${totalOpen} 条，本次列出 ${totalShown} 条${noSnapshot ? `；${noSnapshot} 条视频还没抓过` : ""}${outOfWindow ? `；${outOfWindow} 条视频发布超 ${MAX_VIDEO_AGE} 天已排除（涉及 ${outOfWindowOpen} 条未回）` : ""}`);

const text = lines.join("\n");
if (OUT) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text, "utf8");
  console.log(`已写入 ${OUT}`);
} else {
  console.log(text);
}
