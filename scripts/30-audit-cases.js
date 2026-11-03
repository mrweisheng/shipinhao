#!/usr/bin/env node
/**
 * 30-audit-cases.js — 把案例库里不符合现行口径的 good 案例重新定性
 *
 * 背景（2026-11-01）：
 *   案例库的 good 会被 `15-case-library --search` 检索出来当范本仿写。
 *   里面仍有一批旧口径（費用明細 / 私訊出口 / 多路径 CTA / 承诺词 / 报价格），
 *   等于一边立新规、一边拿旧样本教模型。本脚本只做定性，不改写原文。
 *
 * 定性规则：
 *   含内容问题（费用 / 价格 / 多路径 / 承诺 / 免责 / 参数拼接 / 禁词）→ bad（回复本身有错）
 *   只是用「私訊」出口、内容没错                                  → dropped（过时，不当反面教材）
 *   其他保持 good
 *   说明：命令行动作叫 reject / drop，落库标签分别是 bad / dropped（与案例库语义一致）。
 *
 * 用法：
 *   node scripts\30-audit-cases.js            # 只报告
 *   node scripts\30-audit-cases.js --apply    # 落库
 */

const fs = require("fs");
const path = require("path");
const caseLib = require("./lib/case-library");

const APPLY = process.argv.includes("--apply");
const FILES = [caseLib.SEED, caseLib.CASES];
const PROMISE = /冇問題|没问题|包批|包過|包过|一定得|一定批|保證|保证|包搞掂/;
const HEDGE = /幫你確認|帮你确认|要確認|要确认|唔確定|不确定/;
const PRIVATE = /私訊|私信|\bPM\b|\bDM\b|置頂|置顶|📩|💬/;

function readRows(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((s) => s.trim())
    .map((s) => JSON.parse(s));
}

function writeRows(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function classify(row) {
  const reply = row.reply || "";
  // 私信类出口单独处理：只是出口过时、内容没错 → dropped（不当反面教材）
  const errs = caseLib.contentErrors(reply).filter((e) => !/私信类禁用/.test(e));
  if (PROMISE.test(reply)) errs.push("承诺词（冇問題／包批／保證／一定批）");
  if (HEDGE.test(reply)) errs.push("推托词（幫你確認／要確認／唔確定）");
  if (errs.length) {
    return { to: "bad", why: errs.join("；") };
  }
  if (PRIVATE.test(reply)) {
    return { to: "dropped", why: "私信/置顶出口过时；内容本身没错" };
  }
  return null;
}

let total = 0;
const changes = [];
for (const file of FILES) {
  const rows = readRows(file);
  const goodBefore = rows.filter((r) => r.label === "good").length;
  let changed = 0;
  for (const row of rows) {
    if (row.label !== "good") continue;
    total++;
    const hit = classify(row);
    if (!hit) continue;
    const before = row.label;
    row.label = hit.to;
    row.note = `${row.note ? row.note + "｜" : ""}2026-11-02 ${hit.to}：${hit.why}`;
    row.updatedAt = new Date().toISOString();
    changed++;
    changes.push({ file: path.basename(file), id: row.id, from: before, to: hit.to, why: hit.why, reply: row.reply });
  }
  if (APPLY && changed) writeRows(file, rows);
  console.log(`${path.basename(file)}：good ${goodBefore} 条，本次定性 ${changed} 条${APPLY ? "（已写入）" : "（未写入）"}`);
}

const by = {};
for (const c of changes) by[c.to] = (by[c.to] || 0) + 1;
console.log(`\n扫描 good ${total} 条，需定性 ${changes.length} 条：`, by);
for (const c of changes) {
  console.log(`  ${c.id} → ${c.to}｜${c.why}`);
  console.log(`     ${c.reply}`);
}
if (!APPLY && changes.length) console.log("\n加 --apply 落库。");
if (!changes.length) console.log("没有需要定性的案例。");
