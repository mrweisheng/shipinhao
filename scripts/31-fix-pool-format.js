#!/usr/bin/env node
/**
 * 31-fix-pool-format.js — 模板池格式整改（2026-11-01）
 *
 * 做两件事：
 *   1. 删除 legacy 三组（GUIDE-FULL / GUIDE-SYMBOL / GUIDE-TALK）：都是「點頭像 + 私訊」多路径，
 *      2026-10-30 起已被 13 拦截，留在池里只会被误抄。
 *   2. 把句尾/句首的表情移到句中（现行 checkText 规则）。
 *
 * 用法：
 *   node scripts\31-fix-pool-format.js            # 只预览
 *   node scripts\31-fix-pool-format.js --apply    # 写回 模板池.md
 *   node scripts\31-fix-pool-format.js --keep-legacy
 */

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "模板池.md");
const APPLY = process.argv.includes("--apply");
const KEEP_LEGACY = process.argv.includes("--keep-legacy");

const EMO = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF\uFE0F]/u;
const TRAIL = /\s*([\u{1F300}-\u{1FAFF}\u2600-\u27BF\uFE0F]+)\s*$/u;
const LEAD = /^\s*([\u{1F300}-\u{1FAFF}\u2600-\u27BF\uFE0F]+)\s*/u;
const PUNCT = /[，,；;、？?！!]/;
const LEGACY = /^GUIDE-(FULL|SYMBOL|TALK)$/;

// 句首是固定词组时，表情插在词组之后，不要从中间劈开
const KEEP = [
  "深圳灣牌",
  "港車北上",
  "過去做工",
  "頭像入面",
  "私訊明哥",
  "私訊傾下",
  "兩地牌",
  "中港牌",
  "蓮塘牌",
  "口岸牌",
  "呢方面",
  "有途徑",
  "有得搞",
  "有經驗",
  "收車價",
  "頭像度",
  "私訊我",
  "去主頁",
].sort((a, b) => b.length - a.length);

const SPECIAL = {
  有道理: "有道理 😄 係呀",
  穩穩陣陣: "穩穩陣陣 😊 係呀",
  多謝: "多謝晒 🙏 支持",
  感恩: "感恩 🙏 支持",
  多謝你: "多謝你 🙏 支持",
  有心: "有心 🙏 心領",
  收到: "收到 🙏 明白",
  明白: "明白 🙏 收到",
  哈哈: "哈哈 😄 係呀",
  我哋熟: "可以 😄 我哋熟",
  "見我頭像👤": "見我頭像👤 就見到",
  "置頂有齊資料，睇🔝": "置頂有齊資料 😄 睇🔝 就知",
};

function fixEmoji(text) {
  let s = String(text).trim();
  if (!s) return s;

  // 纯表情：没有关键词可绑，保持原样
  const compact = s.replace(/\s/g, "");
  if ([...compact].every((ch) => EMO.test(ch))) return s;

  const trail = s.match(TRAIL);
  const trailEmoji = trail ? trail[1] : null;
  if (trail) s = s.slice(0, trail.index).trim();

  const lead = s.match(LEAD);
  const leadEmoji = lead ? lead[1] : null;
  if (lead) s = s.slice(lead[0].length).trim();

  const useEmoji = trailEmoji || leadEmoji || "🙏";

  const key = s.replace(/\s/g, "");
  if (SPECIAL[key]) return SPECIAL[key];

  // 已经有句中表情：去掉句尾那个即可；若表情正好落在句尾，补两个字
  if (EMO.test(s)) {
    const chars = [...s];
    return EMO.test(chars[chars.length - 1]) ? `${s} 就知` : s;
  }

  const p = s.match(PUNCT);
  if (p && p.index >= 1) {
    return `${s.slice(0, p.index)} ${useEmoji} ${s.slice(p.index + 1).trim()}`;
  }

  const arr = [...s];
  if (arr.length <= 2) return `${s} ${useEmoji} 支持`;
  const keep = KEEP.find((k) => s.startsWith(k) && s.length > k.length);
  const cut = keep ? keep.length : arr.length <= 3 ? 1 : 2;
  return `${arr.slice(0, cut).join("")} ${useEmoji} ${arr.slice(cut).join("")}`;
}

const lines = fs.readFileSync(FILE, "utf8").split(/\r?\n/);
const out = [];
let section = null;
let dropping = false;
let removed = 0;
let fixed = 0;
const samples = [];

for (const line of lines) {
  const h = line.match(/^##\s+([A-Z][A-Z0-9-]*)\s*(?:·|$)/);
  if (h) {
    section = h[1];
    dropping = !KEEP_LEGACY && LEGACY.test(section);
    if (dropping) removed++;
    if (dropping) continue;
    out.push(line);
    continue;
  }
  if (dropping) {
    if (/^-\s+`[A-Z0-9-]+`\s+/.test(line)) removed++;
    continue;
  }

  const m = line.match(/^(- `([A-Z0-9-]+)`\s+)(.+)$/);
  if (m) {
    const before = m[3].trim();
    const after = fixEmoji(before);
    if (after !== before) {
      fixed++;
      if (samples.length < 25) samples.push({ id: m[2], before, after });
    }
    out.push(m[1] + after);
  } else {
    out.push(line);
  }
}

const text = out.join("\n");
const remainingEdge = (text.match(/^- `[A-Z0-9-]+`\s+.+$/gm) || []).filter((l) => {
  const t = l.replace(/^- `[A-Z0-9-]+`\s+/, "").trim();
  const c = [...t];
  return EMO.test(c[0]) || EMO.test(c[c.length - 1]);
}).length;

console.log(`模板行：修正表情 ${fixed} 条；删除 legacy 段/行 ${removed}；剩余表情在首尾 ${remainingEdge} 条`);
console.log("\n示例：");
for (const s of samples) console.log(`  ${s.id}\n    ${s.before}\n →  ${s.after}`);

if (APPLY) {
  fs.writeFileSync(FILE, text, "utf8");
  console.log("\n已写回 模板池.md");
} else {
  console.log("\n未写入。加 --apply 落库。");
}

module.exports = { fixEmoji };
