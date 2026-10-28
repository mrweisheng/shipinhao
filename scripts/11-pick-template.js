#!/usr/bin/env node
/**
 * 11-pick-template.js — 从语料池抽几条同场景候选（给模型起草时参考）
 *
 * 注意：这里不做业务判断，也不自动发送；只是避免「连着几条一模一样」。
 *
 * 用法：
 *   node scripts/11-pick-template.js --list
 *   node scripts/11-pick-template.js --validate
 *   node scripts/11-pick-template.js --category PRAISE --count 5
 *   node scripts/11-pick-template.js --category CAR-PRICE --price 12萬8 --avoid "多謝支持 🙏"
 */

const fs = require("fs");
const path = require("path");
const pool = require("./lib/template-pool");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return d;
};

const FILE = getArg("file", pool.DEFAULT_FILE);
const CAT = getArg("category", null);
const PRICE = getArg("price", null);
const COUNT = Number(getArg("count", "1"));
const AVOID = (getArg("avoid", "") || "").split("|").map((s) => s.trim()).filter(Boolean);
const HISTORY = getArg("history", pool.HISTORY_FILE);
const JSON_OUT = getArg("json", null);

function main() {
  if (argv.includes("--list")) {
    const rows = pool.list(FILE);
    console.log(`模板池：${FILE}`);
    console.log(`分类 ${rows.length} 个，模板 ${rows.reduce((n, r) => n + r.count, 0)} 条\n`);
    for (const r of rows) {
      console.log(`${r.category.padEnd(20)} ${String(r.count).padStart(3)} 条` +
        (r.guided ? `（含引導 ${r.guided}）` : "") + `  ${r.title}`);
    }
    return;
  }

  if (argv.includes("--validate")) {
    const v = pool.validate(FILE);
    if (v.ok) {
      console.log(`✓ 校验通过：${v.categories.length} 个分类，` +
        `${v.categories.reduce((n, r) => n + r.count, 0)} 条模板`);
    } else {
      console.error(`✗ 校验失败 ${v.errors.length} 处：`);
      for (const e of v.errors) console.error("  - " + e);
      process.exitCode = 1;
    }
    return;
  }

  if (!CAT) {
    console.error("需要 --category 分类，或 --list / --validate");
    process.exitCode = 1;
    return;
  }

  const history = pool.readHistory(HISTORY);
  const { pool: parsed } = pool.parse(FILE);
  const picked = [];
  const avoid = [...AVOID];

  for (let i = 0; i < COUNT; i++) {
    const t = pool.pick(CAT, { price: PRICE, avoid, history, pool: parsed });
    picked.push(t);
    avoid.push(t.text);
  }

  if (JSON_OUT) {
    const dir = path.dirname(JSON_OUT);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(JSON_OUT, JSON.stringify({ category: CAT, price: PRICE, items: picked }, null, 2), "utf8");
  }

  for (const p of picked) {
    console.log(`${p.id}\t${p.text}${p.guide ? "\t[引導]" : ""}`);
  }
}

main();
