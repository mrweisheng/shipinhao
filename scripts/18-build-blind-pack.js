#!/usr/bin/env node
/** 18-build-blind-pack.js — 为 30 条评论准备「模板基线 + 相似案例」，给生成器用 */
const fs = require("fs");
const path = require("path");
const lib = require("./lib/case-library");

const IN = path.join(__dirname, "..", "data", "eval", "selected-30.json");
const OUT = path.join(__dirname, "..", "data", "eval", "blind-pack.json");
const rows = JSON.parse(fs.readFileSync(IN, "utf8"));

const out = rows.map((r) => {
  let cases = lib.search(r.comment, { intent: r.intent, top: 3 });
  if (!cases.length) cases = lib.search(r.comment, { top: 3 });
  return {
    ...r,
    cases: cases.map((c) => ({ id: c.id, label: c.label, score: Number(c.score.toFixed(3)), comment: c.comment, reply: c.reply, note: c.note })),
  };
});

fs.writeFileSync(OUT, JSON.stringify({ createdAt: new Date().toISOString(), items: out }, null, 2), "utf8");
console.log(`已生成 ${out.length} 条 → ${OUT}`);
for (const r of out) {
  console.log(`${r.id} ${r.intent} :: ${r.comment.slice(0, 40)}`);
  for (const c of r.cases) console.log(`   ${c.id} [${c.label}] ${c.score} ${c.reply.slice(0, 40)}`);
}
