/**
 * lib/case-library.js — 真实案例库（comment → reply → outcome）
 *
 * 和模板池的区别：
 *   模板池：预写句子，按分类挑一条。
 *   案例库：真实评论 + 当时的回复 + 结果标签；检索相似案例给模型参考，模型再写。
 *
 * 自动入库只进“候选（unreviewed）”，不会自动变成 good；
 * 必须经过 promote / 结果回流才升级，避免把错误话术学进去。
 */

const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "..", "data", "cases");
const SEED = path.join(DIR, "seed.jsonl");
const CASES = path.join(DIR, "cases.jsonl");
const QUEUE = path.join(DIR, "novel-queue.jsonl");

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function load() {
  const map = new Map();
  for (const c of readJsonl(SEED)) map.set(c.id, c);
  for (const c of readJsonl(CASES)) map.set(c.id, c); // 后者覆盖前者（用于状态更新）
  return [...map.values()];
}

/** 中文：单字 + 二元组；英文/数字保留整词。去标点空格。 */
function tokenize(text) {
  const s = String(text || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  const tokens = [];
  const han = s.match(/\p{Script=Han}+/gu) || [];
  for (const run of han) {
    for (const ch of run) tokens.push(ch);
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  for (const w of s.match(/[a-z0-9]+/g) || []) tokens.push(w);
  return tokens;
}

function buildModel(cases) {
  const docs = cases.map((c) => ({ c, tf: new Map() }));
  const df = new Map();
  for (const d of docs) {
    for (const t of tokenize([d.c.comment, d.c.intent, d.c.business].join(" "))) {
      d.tf.set(t, (d.tf.get(t) || 0) + 1);
    }
    for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = docs.length;
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.log((N + 1) / (n + 1)) + 1);

  for (const d of docs) {
    let norm = 0;
    const vec = new Map();
    for (const [t, n] of d.tf) {
      const w = n * (idf.get(t) || 1);
      vec.set(t, w);
      norm += w * w;
    }
    d.vec = vec;
    d.norm = Math.sqrt(norm) || 1;
  }
  return { docs, idf, N };
}

function vectorize(text, idf) {
  const tf = new Map();
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + 1);
  let norm = 0;
  const vec = new Map();
  for (const [t, n] of tf) {
    const w = n * (idf.get(t) || 1);
    vec.set(t, w);
    norm += w * w;
  }
  return { vec, norm: Math.sqrt(norm) || 1 };
}

function cosine(a, b) {
  let dot = 0;
  const [small, large] = a.vec.size <= b.vec.size ? [a, b] : [b, a];
  for (const [t, w] of small.vec) {
    if (large.vec.has(t)) dot += w * large.vec.get(t);
  }
  return dot / (a.norm * b.norm);
}

function search(query, { top = 5, business = null, label = null, intent = null } = {}) {
  const cases = load();
  const model = buildModel(cases);
  const q = vectorize(query, model.idf);
  const scored = [];
  for (const d of model.docs) {
    if (d.c.label === "dropped") continue; // 淘汰：不进检索、不当例子，但留档可审计
    if (business && d.c.business && d.c.business !== business && d.c.business !== "any") continue;
    if (label && d.c.label !== label) continue;
    if (intent && d.c.intent !== intent) continue;
    scored.push({ ...d.c, score: cosine(q, d) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, top);
}

function nextId(cases) {
  const nums = cases.map((c) => Number(String(c.id).replace(/\D/g, "")) || 0);
  return "c" + String(Math.max(0, ...nums) + 1).padStart(3, "0");
}

/**
 * 新增案例。默认 label=unreviewed。
 * 如果和现有案例最大相似度 < threshold，标记 novel=true，并写入 novel-queue。
 */
function add(entry, { threshold = 0.35 } = {}) {
  const cases = load();
  const norm = (s) => String(s || "").replace(/\s+/g, "").trim();
  const same = cases.find(
    (c) => norm(c.comment) === norm(entry.comment) && norm(c.reply) === norm(entry.reply)
  );
  if (same) return { ...same, skipped: true, reason: "same comment+reply already exists" };

  const id = entry.id || nextId(cases);
  const top = search(entry.comment, { top: 1 })[0];
  const maxScore = top ? top.score : 0;
  const novel = maxScore < threshold;
  const row = {
    id,
    comment: String(entry.comment || "").trim(),
    reply: String(entry.reply || "").trim(),
    intent: entry.intent || "unknown",
    business: entry.business || "any",
    label: entry.label || "unreviewed",
    note: entry.note || "",
    novel,
    similarity: Number(maxScore.toFixed(3)),
    source: entry.source || "manual",
    createdAt: new Date().toISOString(),
  };

  const all = readJsonl(CASES).filter((c) => c.id !== id);
  all.push(row);
  writeJsonl(CASES, all);

  if (novel && row.label === "unreviewed") {
    const q = readJsonl(QUEUE).filter((c) => c.id !== id);
    q.push(row);
    writeJsonl(QUEUE, q);
  }
  return row;
}

function updateLabel(id, label, note, patch = null) {
  const all = readJsonl(CASES);
  const i = all.findIndex((c) => c.id === id);
  if (i < 0) throw new Error(`cases.jsonl 没有 ${id}（seed 案例请先复制到 cases.jsonl 再改）`);
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
  }
  all[i] = { ...all[i], ...clean, label, note: note || all[i].note, updatedAt: new Date().toISOString() };
  writeJsonl(CASES, all);

  // 定过性（good / bad / dropped）的案例就不再是「待确认新场景」，从队列里移除
  if (label !== "unreviewed") {
    const q = readJsonl(QUEUE);
    const kept = q.filter((r) => r.id !== id);
    if (kept.length !== q.length) writeJsonl(QUEUE, kept);
  }

  return all[i];
}

function stats() {
  const cases = load();
  const by = (k) => {
    const m = {};
    for (const c of cases) m[c[k] || "?"] = (m[c[k] || "?"] || 0) + 1;
    return m;
  };
  return {
    total: cases.length,
    label: by("label"),
    business: by("business"),
    intent: by("intent"),
    novel: cases.filter((c) => c.novel).length,
    queue: readJsonl(QUEUE).length,
    seed: readJsonl(SEED).length,
    auto: readJsonl(CASES).length,
  };
}

module.exports = { load, search, add, updateLabel, stats, tokenize, QUEUE, CASES, SEED };
