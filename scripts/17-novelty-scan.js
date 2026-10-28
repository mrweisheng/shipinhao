#!/usr/bin/env node
/**
 * 17-novelty-scan.js — 案例覆盖度扫描（只读）
 *
 * 输出两套口径：
 *   全量：强匹配 / 部分匹配 / 无相近案例（novel）
 *   业务向：只算「可能需要回复」的评论，才是案例库真正的缺口
 *
 * 为什么要有业务向口径：
 *   观点类视频下大量评论是争论 / 唱衰 / 地域对比 / 纯表情，动作本来就是 skip，
 *   给它们准备案例没有意义。只按全量算，覆盖率永远显得不够。
 *
 * 注意：这里的「业务向」是**统计用的启发式**，只用来算覆盖度，
 *      绝不参与「回不回」的判断（回不回只看 SKILL 第 3 节，模型逐条读完整句）。
 *
 * 用法：
 *   node scripts/17-novelty-scan.js
 *   node scripts/17-novelty-scan.js --input .\data\eval\comments-100.json --n 100
 *   node scripts/17-novelty-scan.js --business-only      # 只列业务向缺口
 */

const fs = require("fs");
const path = require("path");
const lib = require("./lib/case-library");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const IN = getArg("input", path.join(__dirname, "..", "data", "eval", "comments-100.json"));
const OUT = getArg("out", path.join(__dirname, "..", "data", "eval", "novelty-report.json"));
const N = Number(getArg("n", "100"));

const HAN = /[\p{Script=Han}]/u;

// ── 统计用启发式（不是回复规则）─────────────────────────────
// 疑问信号：有这些字，基本是在问东西
const ASK = /[?？]|嗎|吗|呢|幾多|几多|多少|幾時|几时|點|怎么|怎樣|怎样|如何|可否|能否|可以|邊|哪|甚麼|什么|係唔係|是不是/;
// 业务话题：车 / 牌 / 移民 / 求职 / 价格 / 门路 / 地址 相关
const TOPIC =
  /車|车|牌|價|价|錢|钱|分期|首期|月供|按揭|移民|高才|優才|优才|簽證|签证|身份|證件|证件|學歷|学历|招聘|招工|做嘢|做工|求職|求职|門路|门路|條件|条件|地址|邊度|边度|幾點|几点|營業|营业|回收|驗車|验车|試車|试车|現車|现车|配置|顏色|颜色|聯繫|联系|私訊|私信|介紹|介绍/;

function scopeOf(text) {
  if (!HAN.test(text) && !/[A-Za-z0-9]/.test(text)) return "emoji";
  const isAsk = ASK.test(text);
  const isTopic = TOPIC.test(text);
  if (isAsk && isTopic) return "ask+topic";
  if (isAsk) return "ask";
  if (isTopic) return "topic";
  return "other";
}

const BUSINESS_SCOPES = new Set(["ask+topic", "ask", "topic"]);

const j = JSON.parse(fs.readFileSync(IN, "utf8"));
const comments = (j.comments || []).slice(0, N);

const rows = [];
for (const c of comments) {
  const text = String(c.comment || "");
  const scope = scopeOf(text);
  const top = lib.search(text, { top: 3 });
  const best = top[0] || null;
  const score = best ? best.score : 0;
  const bucket = scope === "emoji" ? "emoji" : score >= 0.6 ? "strong" : score >= 0.35 ? "partial" : "novel";
  rows.push({
    ...c,
    scope,
    business: BUSINESS_SCOPES.has(scope),
    score: Number(score.toFixed(3)),
    bucket,
    best: best ? { id: best.id, label: best.label, score: Number(best.score.toFixed(3)), reply: best.reply } : null,
    top: top.map((t) => ({ id: t.id, label: t.label, score: Number(t.score.toFixed(3)) })),
  });
}

function tally(list) {
  const by = {};
  for (const r of list) by[r.bucket] = (by[r.bucket] || 0) + 1;
  return by;
}
const by = tally(rows);
const biz = rows.filter((r) => r.business);
const byBiz = tally(biz);
const byScope = tallyScope(rows);

function tallyScope(list) {
  const by = {};
  for (const r of list) by[r.scope] = (by[r.scope] || 0) + 1;
  return by;
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "-");

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      total: rows.length,
      summary: by,
      scopeSummary: byScope,
      businessSummary: { total: biz.length, ...byBiz },
      note: "「业务向」为统计启发式（疑问/业务话题），仅用于覆盖度，不参与回复决策",
      rows,
    },
    null,
    2
  ),
  "utf8"
);

console.log(`扫描 ${rows.length} 条`);
console.log(`\n【全量口径】`);
console.log(
  `强匹配(>=0.60) ${by.strong || 0}｜部分(0.35-0.60) ${by.partial || 0}｜无相近(<0.35) ${by.novel || 0}｜表情 ${by.emoji || 0}`
);
console.log(`无相近占比 ${pct(by.novel || 0, rows.length)}`);

console.log(`\n【业务向口径】可能需要回复的 ${biz.length} 条（${pct(biz.length, rows.length)}）`);
console.log(
  `强匹配 ${byBiz.strong || 0}｜部分 ${byBiz.partial || 0}｜无相近 ${byBiz.novel || 0}｜表情 ${byBiz.emoji || 0}`
);
console.log(`业务向无覆盖占比 ${pct(byBiz.novel || 0, biz.length)}`);

console.log(
  `\n分类明细：${Object.entries(byScope)
    .map(([k, v]) => `${k}=${v}`)
    .join("｜")}`
);

const list = has("business-only") ? biz.filter((x) => x.bucket === "novel") : rows.filter((x) => x.bucket === "novel");
console.log(`\n无相近案例（${has("business-only") ? "仅业务向" : "全量"}，共 ${list.length} 条）：`);
for (const r of list.slice(0, 60)) {
  console.log(`- [${r.score}] (${r.scope}) ${String(r.comment).replace(/\s+/g, " ").slice(0, 90)}`);
  if (r.best) console.log(`    最近：${r.best.id} [${r.best.label}] ${r.best.score}｜${String(r.best.reply).slice(0, 40)}`);
}
console.log(`\n报告：${OUT}`);
