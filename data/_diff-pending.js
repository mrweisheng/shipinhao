const fs = require("fs");
const path = require("path");

for (let n = 1; n <= 10; n++) {
  const nf = path.join(__dirname, "maintain-1025", `nth${n}.json`);
  const of = path.join(__dirname, "maintain", `recheck-nth${n}.json`);
  if (!fs.existsSync(nf) || !fs.existsSync(of)) continue;
  const nj = JSON.parse(fs.readFileSync(nf, "utf8"));
  const oj = JSON.parse(fs.readFileSync(of, "utf8"));
  const key = (c) => `${c.author}|${c.content}`;
  const oldSet = new Set((oj.comments || []).filter((c) => c.level === 1).map(key));
  const pending = (nj.comments || []).filter((c) => c.level === 1 && !c.authorReplied && !c.isAuthor);
  const fresh = pending.filter((c) => !oldSet.has(key(c)));
  if (fresh.length) {
    console.log(`\n===== nth${n} 新增待回 ${fresh.length} =====`);
    for (const c of fresh) console.log(`[${c.index}] ${c.author} ${c.time} :: ${String(c.content).replace(/\s+/g, " ").slice(0, 110)}`);
  }
}
