#!/usr/bin/env node
/**
 * 22-diff-snapshots.js — 对比两次抓取，捞出「新增且未回」的评论（只读）
 *
 * 日常维护只需要看新增，不需要看总数和消失的评论。
 * 这个脚本就是为这件事存在的，避免每次临时写代码。
 *
 * 用法：
 *   node scripts/22-diff-snapshots.js --old .\data\maintain-1025 --new .\data\maintain-1026
 *   node scripts/22-diff-snapshots.js --old ... --new ... --n 10 --business-only
 *   node scripts/22-diff-snapshots.js --old ... --new ... --removed      # 顺便看消失了哪些
 *
 * 关键点：
 *   1. 比对前**必须归一化表情**。表情的 alt 文本会在「[玫瑰]」「[Rose]」「[emoji]」之间变，
 *      不归一化会把同一批评论误判成「删一批、又增一批」（2026-10-27 实测踩过）。
 *   2. 新增里要排除作者自己的回复，否则自己的回复会被当成新评论。
 *   3. --business-only 用疑问/业务话题做统计过滤，只用于缩小阅读范围，不参与回不回判断。
 */

const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  return eq ? eq.split("=").slice(1).join("=") : d;
};
const has = (n) => argv.includes(`--${n}`);

const OLD = getArg("old");
const NEW = getArg("new");
const N = Number(getArg("n", "20"));
if (!OLD || !NEW) {
  console.error("用法：node scripts/22-diff-snapshots.js --old <旧目录> --new <新目录> [--n 10] [--business-only] [--removed]");
  process.exit(1);
}

function norm(s) {
  return String(s || "")
    .replace(/\[[^\]]{0,20}\]/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}
const key = (c) => `${norm(c.author)}|${norm(c.content)}`;

const ASK = /[?？]|嗎|吗|呢|幾多|几多|多少|幾時|几时|點|怎么|怎樣|怎样|如何|可否|能否|可以|邊|哪|甚麼|什么|係唔係|是不是/;
const TOPIC = /車|车|牌|價|价|錢|钱|分期|首期|月供|按揭|移民|高才|優才|优才|簽證|签证|身份|證件|证件|學歷|学历|招聘|招工|求職|求职|門路|门路|條件|条件|地址|邊度|边度|幾點|几点|營業|营业|回收|驗車|验车|試車|试车|現車|现车|配置|顏色|颜色|聯繫|联系|私訊|私信|介紹|介绍/;
function isBusinessish(text) {
  return ASK.test(text) || TOPIC.test(text);
}
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

const files = fs
  .readdirSync(NEW)
  .filter((f) => /^nth\d+\.json$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
  .slice(0, N);

let totalNew = 0;
let totalBiz = 0;
const perVideo = [];

// 序号会变（发新视频后整体右移），所以先按「标题」把旧快照建索引，再退回按文件名
const titleKey = (d) => String((d.video || {}).title || "").replace(/\s+/g, "");
const oldByTitle = new Map();
for (const f of fs.readdirSync(OLD)) {
  if (!/^nth\d+\.json$/.test(f)) continue;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(OLD, f), "utf8"));
    const k = titleKey(d);
    if (k) oldByTitle.set(k, { d, f });
  } catch {}
}

let shifted = [];

for (const f of files) {
  const pNew = path.join(NEW, f);
  if (!fs.existsSync(pNew)) continue;
  const b = JSON.parse(fs.readFileSync(pNew, "utf8"));

  let a = { comments: [] };
  let matchedBy = "none";
  const hit = oldByTitle.get(titleKey(b));
  if (hit) {
    a = hit.d;
    matchedBy = hit.f === f ? "name" : `title(${hit.f})`;
    if (hit.f !== f) shifted.push(`${f} ← ${hit.f}`);
  } else {
    const pOld = path.join(OLD, f);
    if (fs.existsSync(pOld)) {
      a = JSON.parse(fs.readFileSync(pOld, "utf8"));
      matchedBy = "name";
    }
  }

  const sa = a.summary || {};
  const sb = b.summary || {};
  const setOld = new Map();
  for (const c of a.comments || []) setOld.set(key(c), c);

  const added = (b.comments || []).filter((c) => c.level === 1 && !c.isAuthor && !setOld.has(key(c)));
  const newUnreplied = added.filter((c) => !c.authorReplied);
  const newRepliedAlready = added.filter((c) => c.authorReplied);
  const biz = newUnreplied.filter((c) => isBusinessish(String(c.content)));
  totalNew += newUnreplied.length;
  totalBiz += biz.length;

  const removed = (a.comments || []).filter(
    (c) => c.level === 1 && !c.isAuthor && !new Map((b.comments || []).map((x) => [key(x), 1])).has(key(c))
  );

  perVideo.push({ f, title: (b.video || {}).title, time: (b.video || {}).time, a, b, sa, sb, newUnreplied, biz, newRepliedAlready, removed, matchedBy });
}

console.log(`对比 ${files.length} 条视频：${OLD} → ${NEW}`);
if (shifted.length) {
  console.log(`⚠ 序号已位移，按标题对齐了 ${shifted.length} 条：${shifted.slice(0, 6).join("、")}${shifted.length > 6 ? " …" : ""}`);
}
console.log("");
for (const v of perVideo) {
  console.log(
    `${v.f}  声明 ${v.a.declared ?? "-"}→${v.b.declared ?? "-"}  已回 ${v.sa.authorRepliedThreads ?? "-"}→${v.sb.authorRepliedThreads ?? "-"}  待回 ${v.sa.awaitingThreads ?? "-"}→${v.sb.awaitingThreads ?? "-"}  新增未回 ${v.newUnreplied.length}（业务向 ${v.biz.length}）  完整=${v.sb.complete}`
  );
  console.log(`      ${clean(v.title).slice(0, 40)}`);
}

console.log(`\n合计新增未回 ${totalNew} 条，其中业务向 ${totalBiz} 条`);

const list = has("business-only") ? perVideo.flatMap((v) => v.biz.map((c) => ({ v: v.f, c }))) : perVideo.flatMap((v) => v.newUnreplied.map((c) => ({ v: v.f, c })));

console.log(`\n=== 新增未回${has("business-only") ? "（业务向）" : ""}：${list.length} 条 ===`);
for (const { v, c } of list) {
  console.log(`[${v.replace("nth", "").replace(".json", "")}-${c.index}] ${clean(c.author)} ${c.time}: ${clean(c.content).slice(0, 90)}`);
}

const already = perVideo.flatMap((v) => v.newRepliedAlready.map((c) => ({ v: v.f, c })));
if (already.length) {
  console.log(`\n=== 新增但作者已回（不用处理）：${already.length} 条 ===`);
  for (const { v, c } of already.slice(0, 20)) {
    console.log(`[${v.replace("nth", "").replace(".json", "")}-${c.index}] ${clean(c.author)}: ${clean(c.content).slice(0, 60)}`);
  }
}

if (has("removed")) {
  const gone = perVideo.flatMap((v) => v.removed.map((c) => ({ v: v.f, c })));
  console.log(`\n=== 消失（归一化后仍不见）：${gone.length} 条 ===`);
  for (const { v, c } of gone) {
    console.log(`[${v.replace("nth", "").replace(".json", "")}-] ${clean(c.author)}: ${clean(c.content).slice(0, 60)}`);
  }
}
