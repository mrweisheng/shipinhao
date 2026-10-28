#!/usr/bin/env node
/** 19-build-blind-judge.js — 把模板基线 A 与案例生成 B 随机打乱成 X/Y，供盲评 */
const fs = require("fs");
const path = require("path");

const PACK = path.join(__dirname, "..", "data", "eval", "blind-pack.json");
const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const REPLIES = getArg("replies", path.join(__dirname, "..", "data", "eval", "case-replies.json"));
const OUT = getArg("out", path.join(__dirname, "..", "data", "eval", "blind-judge.json"));
const MAP = getArg("map", path.join(__dirname, "..", "data", "eval", "blind-map.json"));

const pack = JSON.parse(fs.readFileSync(PACK, "utf8")).items;
const replies = JSON.parse(fs.readFileSync(REPLIES, "utf8"));
const byId = new Map(replies.map((r) => [r.id, r]));

function hash(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}

const items = [];
const map = [];
for (const p of pack) {
  const r = byId.get(p.id);
  if (!r) continue;
  const A = p.baseline || "（不回）";
  const B = r.action === "skip" ? "（不回）" : r.best || "（不回）";
  const swap = hash(p.id) % 2 === 1;
  const X = swap ? B : A;
  const Y = swap ? A : B;
  items.push({ id: p.id, comment: p.comment, X, Y });
  map.push({ id: p.id, A: swap ? "Y" : "X", baseline: A, caseReply: B, action: r.action });
}

fs.writeFileSync(OUT, JSON.stringify({ createdAt: new Date().toISOString(), items }, null, 2), "utf8");
fs.writeFileSync(MAP, JSON.stringify({ createdAt: new Date().toISOString(), map }, null, 2), "utf8");
console.log(`盲评 ${items.length} 条 → ${OUT}`);
