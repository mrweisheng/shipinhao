#!/usr/bin/env node
/** 20-score-blind.js — 解盲并统计：模板 A vs 案例生成 B */
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const JUDGE = getArg("judge", path.join(__dirname, "..", "data", "eval", "judge-result.json"));
const MAP = getArg("map", path.join(__dirname, "..", "data", "eval", "blind-map.json"));
const OUT = getArg("out", path.join(__dirname, "..", "data", "eval", "blind-summary.json"));

const judge = JSON.parse(fs.readFileSync(JUDGE, "utf8"));
const map = new Map(JSON.parse(fs.readFileSync(MAP, "utf8")).map.map((x) => [x.id, x]));

const dims = ["answersQuestion", "factualGrounding", "tone", "compliance", "naturalness"];
const sums = { A: Object.fromEntries(dims.map((d) => [d, 0])), B: Object.fromEntries(dims.map((d) => [d, 0])) };
let a = 0, b = 0, tie = 0;
const rows = [];

for (const r of judge) {
  const m = map.get(r.id);
  if (!m) continue;
  const winnerSide = r.winner === "tie" ? "tie" : r.winner === m.A ? "A" : "B";
  if (winnerSide === "A") a++;
  else if (winnerSide === "B") b++;
  else tie++;

  for (const side of ["A", "B"]) {
    const key = side === "A" ? m.A : (m.A === "X" ? "Y" : "X");
    const s = r[key];
    for (const d of dims) sums[side][d] += s[d] || 0;
  }
  rows.push({ id: r.id, winnerSide, baseline: m.baseline, caseReply: m.caseReply, judgeReason: r.reason, action: m.action });
}

const n = judge.length;
const avg = (side) => Object.fromEntries(dims.map((d) => [d, Number((sums[side][d] / n).toFixed(2))]));
const result = { total: n, wins: { templateA: a, caseB: b, tie }, avg: { A: avg("A"), B: avg("B") }, rows };
fs.writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");

console.log(`共 ${n} 条：模板 A 胜 ${a}｜案例 B 胜 ${b}｜平手 ${tie}`);
console.log(`平均分 A：`, result.avg.A);
console.log(`平均分 B：`, result.avg.B);
console.log(`\n案例 B 胜出的：`);
for (const r of rows.filter((x) => x.winnerSide === "B")) console.log(`- ${r.id}｜A: ${r.baseline}｜B: ${r.caseReply}｜${r.judgeReason}`);
console.log(`\n模板 A 胜出的：`);
for (const r of rows.filter((x) => x.winnerSide === "A")) console.log(`- ${r.id}｜A: ${r.baseline}｜B: ${r.caseReply}｜${r.judgeReason}`);
console.log(`\n平手：`);
for (const r of rows.filter((x) => x.winnerSide === "tie")) console.log(`- ${r.id}｜A: ${r.baseline}｜B: ${r.caseReply}｜${r.judgeReason}`);
console.log(`\n记录：${OUT}`);
