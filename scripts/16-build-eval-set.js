#!/usr/bin/env node
/**
 * 16-build-eval-set.js — 从现有评论 JSON 里抽 100 条做评测集（只读）
 *
 * 用法：node scripts/16-build-eval-set.js --n 100
 */

const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const N = Number(getArg("n", "100"));
const OUT = getArg("out", path.join(__dirname, "..", "data", "eval", "comments-100.json"));
const DIRS = [
  path.join(__dirname, "..", "data", "account-new"),
  path.join(__dirname, "..", "data", "maintain"),
];

const HAN = /[\p{Script=Han}]/u;
const Q = /\?|？|吗|嗎|怎么|怎樣|怎样|如何|多少|几多|幾多|可以|有冇|有没有|有沒有|申请|申請|学历|學歷|本科|大专|大專|初中|年龄|年齡|费用|費用|钱|錢|门路|門路|分期|首付|月供|事故|里数|里數|包牌|包税|包稅|保险|保險|地址|几点|幾點|在吗|在嗎|还在|仲有|联系|聯繫|微信/;

function isEmojiOnly(t) {
  const s = String(t || "").replace(/\[[^\]]{1,6}\]/g, "").replace(/[/:][a-z]+/gi, "").replace(/[\s\p{P}\p{S}]/gu, "");
  return s.length === 0;
}

const seen = new Set();
const all = [];

for (const dir of DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!/^(nth|recheck-nth)\d+\.json$/.test(f)) continue;
    const file = path.join(dir, f);
    let j;
    try {
      j = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    for (const c of j.comments || []) {
      if (c.level !== 1) continue;
      const text = String(c.content || "").trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      all.push({
        comment: text,
        author: c.author,
        time: c.time,
        video: j.video && j.video.title,
        declared: j.declared,
        source: path.relative(path.join(__dirname, ".."), file).replace(/\\/g, "/"),
      });
    }
  }
}

const question = all.filter((x) => Q.test(x.comment));
const emoji = all.filter((x) => isEmojiOnly(x.comment));
const text = all.filter((x) => !isEmojiOnly(x.comment) && !Q.test(x.comment));

const picked = [];
const take = (arr, n) => {
  for (const x of arr) {
    if (picked.length >= N) break;
    if (n-- <= 0) break;
    if (!picked.includes(x)) picked.push(x);
  }
};

// 40 问句 / 40 文字 / 10 表情 / 补足
take(question, 40);
take(text, 40);
take(emoji, 10);
take(all, N - picked.length);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      total: picked.length,
      stats: { all: all.length, question: question.length, text: text.length, emoji: emoji.length },
      comments: picked.slice(0, N),
    },
    null,
    2
  ),
  "utf8"
);

console.log(`候选池 ${all.length} 条（问句 ${question.length} / 文字 ${text.length} / 表情 ${emoji.length}）`);
console.log(`已抽取 ${Math.min(N, picked.length)} 条 → ${OUT}`);
