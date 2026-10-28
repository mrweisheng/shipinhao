const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "data", "probe");
for (let i = 1; i <= 3; i++) {
  const f = path.join(dir, `comment-api-${i}.json`);
  if (!fs.existsSync(f)) continue;
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  const d = j.data || {};
  const cs = d.comment || [];
  let l2 = 0;
  let withReplies = 0;
  let truncated = 0;
  const rows = cs.map((c) => {
    const kids = c.levelTwoComment || [];
    l2 += kids.length;
    if (kids.length) withReplies++;
    const cont = kids.some((k) => k.downContinueFlag === 1 || (k.levelTwoComment && k.levelTwoComment.length));
    if (cont) truncated++;
    return {
      user: c.commentNickname,
      txt: (c.commentContent || "").slice(0, 20),
      kids: kids.length,
      kidFlags: kids.map((k) => k.downContinueFlag),
      topBuff: c.lastBuff,
      down: c.downContinueFlag,
    };
  });
  console.log(`\n=== 第 ${i} 页 ===`);
  console.log("keys:", Object.keys(j), "| data keys:", Object.keys(d));
  console.log(`errCode=${j.errCode}  顶层 ${cs.length} 条  二级 ${l2} 条  合计 ${cs.length + l2}  有回复的顶层 ${withReplies}`);
  console.log("data 里的分页/统计字段：", JSON.stringify(
    Object.fromEntries(Object.entries(d).filter(([k]) => k !== "comment").map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v).slice(0, 80) : v])), null, 2));
  console.log("每条：");
  rows.forEach((r, n) => console.log(`  ${n + 1}. ${r.user} 「${r.txt}」 二级=${r.kids} flags=${JSON.stringify(r.kidFlags)} down=${r.down}`));
}
