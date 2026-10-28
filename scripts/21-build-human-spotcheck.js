#!/usr/bin/env node
/** 21-build-human-spotcheck.js — 生成 10 条人工盲抽检清单（不含答案） */
const fs = require("fs");
const path = require("path");

const IN = path.join(__dirname, "..", "data", "eval", "blind-judge-round2.json");
const MD = path.join(__dirname, "..", "data", "eval", "human-spotcheck.md");
const CSV = path.join(__dirname, "..", "data", "eval", "human-spotcheck.csv");

const IDS = ["e01", "e02", "e03", "e07", "e09", "e13", "e18", "e26", "e29", "e30"];
const items = JSON.parse(fs.readFileSync(IN, "utf8")).items;
const picked = IDS.map((id) => items.find((x) => x.id === id)).filter(Boolean);

const lines = [];
lines.push("# 人工抽检（10 条，盲评）");
lines.push("");
lines.push("> 不用看文件、不用猜哪边是模板。只看 X / Y 哪条更像你会发的回复。");
lines.push("> 选 `X` / `Y` / `平`，写在最后一行；有想改的，写一句原因。");
lines.push("");

picked.forEach((x, i) => {
  lines.push(`## ${i + 1}. ${x.comment}`);
  lines.push("");
  lines.push(`- **X**：${x.X}`);
  lines.push(`- **Y**：${x.Y}`);
  lines.push("");
  lines.push(`选择：____　原因（可选）：`);
  lines.push("");
});

lines.push("---");
lines.push("");
lines.push("回复格式：`1Y 2X 3平 …`，或直接在每条形旁边写。");
fs.writeFileSync(MD, lines.join("\n"), "utf8");

const csv = ["id,comment,choice,note"];
for (const x of picked) {
  const c = `"${String(x.comment).replace(/"/g, '""')}"`;
  csv.push(`${x.id},${c},,`);
}
fs.writeFileSync(CSV, "\uFEFF" + csv.join("\n") + "\n", "utf8");

console.log(`已生成 ${picked.length} 条 → ${MD}`);
console.log(CSV);
