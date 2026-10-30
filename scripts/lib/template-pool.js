/**
 * lib/template-pool.js — 读取并解析「模板池.md」
 *
 * 模板池是唯一文案来源（人可读）；脚本按 section 归类，按 7 天查重取用。
 * 格式约定：
 *   ## CAR-STOCK · 问车 / 在不在
 *   - `CAR-STOCK-01` 有，白色有得傾 🙏
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_FILE = path.join(__dirname, "..", "..", "模板池.md");
const WEEK = 7 * 24 * 3600 * 1000;

const BANNED = [
  "微信", "vx", "wechat", "電話", "电话", "手機", "手机", "加我",
  "二維碼", "二维码", "號碼", "号码",
  "聯繫方式", "联系方式", "聯絡方式", "联络方式",
  "私信",  // 简体；繁体「私訊」允许
  "唔方便喺度講", "唔方便喺度讲", "私下講", "私下讲",
];
const GUIDE = /頭像|头像|簡介|简介|私訊|置頂|置顶|主頁|主页|🔍|📩|💬|🔝|頂部|顶部|\bPM\b/i;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF\uFE0F]/u;

function parse(file = DEFAULT_FILE) {
  const text = fs.readFileSync(file, "utf8");
  const pool = {};
  const meta = {};
  let cur = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = line.match(/^##\s+([A-Z][A-Z0-9-]*)\s*(?:·\s*(.*))?$/);
    if (h) {
      cur = h[1];
      pool[cur] = pool[cur] || [];
      meta[cur] = { key: cur, title: (h[2] || "").trim() };
      continue;
    }
    if (!cur) continue;
    const m = line.match(/^-\s+`([A-Z0-9-]+)`\s+(.+)$/);
    if (!m) continue;
    pool[cur].push({ id: m[1], text: m[2].trim(), guide: GUIDE.test(m[2]) });
  }

  // 「SKIP」是文档表格，不是模板分类，剔掉
  delete pool.SKIP;
  delete meta.SKIP;
  return { pool, meta, file };
}

function list(poolFile) {
  const { pool, meta } = parse(poolFile);
  return Object.keys(pool)
    .filter((k) => pool[k].length)
    .map((k) => ({
      category: k,
      title: (meta[k] && meta[k].title) || "",
      count: pool[k].length,
      guided: pool[k].filter((t) => t.guide).length,
    }));
}

function fill(t, price) {
  return price ? t.replace(/\{price\}/g, price) : t;
}

/** 校验：禁词 / 长度 / 表情 */
function validate(poolFile) {
  const { pool } = parse(poolFile);
  const errors = [];
  for (const cat of Object.keys(pool)) {
    for (const t of pool[cat]) {
      const text = fill(t.text, "12萬8");
      const low = text.toLowerCase();
      const hits = BANNED.filter((w) => low.includes(w.toLowerCase()));
      if (hits.length) errors.push(`${t.id}: 禁词 ${hits.join("/")}`);
      if ([...text.replace(/\s/g, "")].length > 22) errors.push(`${t.id}: 超过 22 字（${text}）`);
      if (!EMOJI_RE.test(text)) errors.push(`${t.id}: 缺少表情（${text}）`);
      if (/\{price\}/.test(text) && !/^CAR-(PRICE|FULL)-/.test(cat)) {
        errors.push(`${t.id}: 非价格分类却用了 {price}`);
      }
    }
  }
  return { ok: errors.length === 0, errors, categories: list(poolFile) };
}

/**
 * 取一条模板。
 * @param {string} category
 * @param {object} opt { price, avoid:[string], history:[{text,at}], now }
 */
function pick(category, opt = {}) {
  const poolMap = opt.pool || parse(opt.file).pool;
  const items = poolMap[category];
  if (!items || !items.length) throw new Error(`模板池没有分类 ${category}`);

  const now = opt.now || Date.now();
  const price = opt.price || null;
  const avoid = new Set(opt.avoid || []);
  const history = opt.history || [];

  // 7 天内用过的
  const recent = new Map();
  for (const h of history) {
    const at = Date.parse(h.at || 0) || 0;
    if (now - at < WEEK) recent.set(h.text, at);
  }

  let withText = items.map((t) => ({ ...t, out: fill(t.text, price) }));

  // opt.guide === false：优先不带「主頁」的模板（引导配额用尽时）
  if (opt.guide === false) {
    const plain = withText.filter((t) => !t.guide);
    if (plain.length) withText = plain;
  }

  // 1) 7 天没用过、且不在 avoid 里
  let cands = withText.filter((t) => !recent.has(t.out) && !avoid.has(t.out));
  // 2) 放宽：允许 7 天内用过，但仍在 avoid 里排除
  if (!cands.length) cands = withText.filter((t) => !avoid.has(t.out));
  // 3) 再放宽：只排除最近 3 条
  if (!cands.length) cands = withText;

  // 优先选最久没用的（同组内随机，避免每次都同一条）
  const lastUsed = (t) => recent.get(t.out) || 0;
  const oldest = Math.min(...cands.map(lastUsed));
  const finalists = cands.filter((t) => lastUsed(t) === oldest);

  const t = finalists[Math.floor(Math.random() * finalists.length)];
  return { id: t.id, text: t.out, guide: t.guide, category };
}

const HISTORY_FILE = path.join(__dirname, "..", "..", "data", "reply", "history.json");

function readHistory(file = HISTORY_FILE) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(j.items) ? j.items : [];
  } catch {
    return [];
  }
}

function appendHistory(entry, file = HISTORY_FILE) {
  const items = readHistory(file);
  items.push(entry);
  // 只保留最近 2000 条，避免无限增长
  const keep = items.slice(-2000);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString(), items: keep }, null, 2), "utf8");
}

module.exports = {
  DEFAULT_FILE,
  BANNED,
  GUIDE,
  parse,
  list,
  validate,
  pick,
  fill,
  readHistory,
  appendHistory,
  HISTORY_FILE,
};
