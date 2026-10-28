#!/usr/bin/env node
/**
 * 15-case-library.js — 案例库：检索 / 新增 / 晋级 / 统计
 *
 * 用法：
 *   node scripts/15-case-library.js --stats
 *   node scripts/15-case-library.js --search "司分期付款嗎" --top 5
 *   node scripts/15-case-library.js --add --comment "..." --reply "..." --intent car_payment --business car --label unreviewed
 *   node scripts/15-case-library.js --promote c041
 *   node scripts/15-case-library.js --reject c041 --reason "答非所问"
 */

const lib = require("./lib/case-library");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return d;
};
const has = (n) => argv.includes(`--${n}`);

function print(rows) {
  for (const r of rows) {
    console.log(
      `${r.id}  ${r.score != null ? r.score.toFixed(3) : "-"}  [${r.label}] ${r.intent}/${r.business}` +
        (r.novel ? "  [NOVEL]" : "") +
        `\n    评论：${r.comment}` +
        `\n    回复：${r.reply}` +
        (r.note ? `\n    备注：${r.note}` : "")
    );
  }
}

function main() {
  if (has("stats")) {
    console.log(JSON.stringify(lib.stats(), null, 2));
    return;
  }

  if (has("search")) {
    const q = getArg("search");
    const rows = lib.search(q, {
      top: Number(getArg("top", "5")),
      business: getArg("business", null),
      label: getArg("label", null),
      intent: getArg("intent", null),
    });
    print(rows);
    return;
  }

  if (has("add")) {
    const row = lib.add({
      comment: getArg("comment"),
      reply: getArg("reply"),
      intent: getArg("intent", "unknown"),
      business: getArg("business", "any"),
      label: getArg("label", "unreviewed"),
      note: getArg("note", ""),
      source: getArg("source", "manual"),
    });
    console.log(JSON.stringify(row, null, 2));
    return;
  }

  if (has("promote")) {
    console.log(
      JSON.stringify(
        lib.updateLabel(getArg("promote"), "good", getArg("note", "人工确认"), {
          business: getArg("business", undefined),
          intent: getArg("intent", undefined),
        }),
        null,
        2
      )
    );
    return;
  }

  if (has("reject")) {
    console.log(JSON.stringify(lib.updateLabel(getArg("reject"), "bad", getArg("reason", "人工否定")), null, 2));
    return;
  }

  // 淘汰：回复本身没错，只是价值低 / 重复度高。
  // 不能标 bad（bad = 错误回复的反面教材），标成 dropped 后不进检索、不当例子。
  if (has("drop")) {
    console.log(JSON.stringify(lib.updateLabel(getArg("drop"), "dropped", getArg("reason", "低价值/重复")), null, 2));
    return;
  }

  console.error("需要 --stats / --search / --add / --promote / --reject / --drop");
  process.exitCode = 1;
}

main();
