/**
 * lib/store.js — 新的按「账号 + 发布时间」组织的存储
 *
 * 目录结构：
 *   data/accounts/<account_id>/
 *     account.json                 账号元信息
 *     videos.jsonl                 一行一条视频（账号内索引）
 *     v/<YYYYMMDD-HHMM>/
 *       latest.json                最近一次完整抓取（覆盖写）
 *       state.jsonl                我们对评论的处理记录（只追加，一行一次决定）
 *
 * 为什么用发布时间当键：
 *   同一账号同一时刻不可能发两条视频（2026-10-28 实测 171/171 唯一），
 *   而序号（--nth）会随新视频发布整体右移，不能做持久化标识。
 *
 * 为什么用 JSON 不用 SQLite：
 *   规模：现 224 条视频 / 1.3 万条评论，即使十倍也不到 10 万行；
 *   真正的成本在浏览器抓取和判断 token，不在查询。
 *   JSON 可读、可 grep、不依赖实验 API，出问题能直接打开看。
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..", "data", "accounts");

function accDir(id) {
  return path.join(ROOT, id);
}
function videoDir(id, pt) {
  return path.join(accDir(id), "v", pt);
}

/** "2026年10月27日 09:50" / "2026/10/27 09:50" → "20261027-0950" */
function publishKey(video) {
  const time = String((video && video.time) || "");
  let m = time.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
  if (!m) m = time.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return `${y}${String(mo).padStart(2, "0")}${String(d).padStart(2, "0")}-${String(h).padStart(2, "0")}${mi}`;
}

/** 评论指纹：作者 + 评论时间（不用内容哈希，评论被编辑时会变） */
function commentFp(c) {
  // 昵称里的 emoji 在不同抓取之间渲染不一致（🔧 ↔ [emoji] ↔ [表情]），
  // 不归一化会导致同一条评论算出不同的 fp，state 匹配不上（2026-10-28 实测）
  const a = String(c.author || "")
    .replace(/\[[^\]]{0,24}\]/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s+/g, "")
    .trim() || "无名";
  const t = String(c.time || "").replace(/\s+/g, " ").trim();
  return `${a}|${t}`;
}

function ensureAccount({ id, displayName, note = "" }) {
  if (!id) throw new Error("缺少 account id");
  const dir = accDir(id);
  fs.mkdirSync(path.join(dir, "v"), { recursive: true });
  const f = path.join(dir, "account.json");
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, JSON.stringify({ id, displayName: displayName || "", note, createdAt: new Date().toISOString() }, null, 2), "utf8");
  }
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

function readAccount(id) {
  const f = path.join(accDir(id), "account.json");
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

function readVideos(id) {
  const f = path.join(accDir(id), "videos.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
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

function writeVideos(id, rows) {
  const f = path.join(accDir(id), "videos.jsonl");
  const sorted = [...rows].sort((a, b) => (a.publishTime < b.publishTime ? 1 : -1));
  const body = sorted.map((r) => JSON.stringify(r)).join("\n") + "\n";
  atomicWrite(f, body);
}

function atomicWrite(file, body) {
  const tmp = file + ".tmp";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, file);
}

/** 抓完一条视频后写入：快照 + 索引行 */
function ingestCapture(id, data, { keepSnapshot = true } = {}) {
  const pt = publishKey(data.video);
  if (!pt) return { ok: false, reason: "无法从发布时间生成键：" + JSON.stringify(data.video) };

  const s = data.summary || {};
  if (keepSnapshot) {
    const dir = path.join(videoDir(id, pt), "latest.json");
    atomicWrite(dir, JSON.stringify(data, null, 1));
  }

  const rows = readVideos(id);
  const i = rows.findIndex((r) => r.publishTime === pt);
  const now = new Date().toISOString();
  // 只有「上一次也是真实抓取」时，增长对比才有意义；
  // 列表页的 commentCount 会少报 5 条以上，不能拿来当基准。
  const prev = i >= 0 ? rows[i] : null;
  const prevCount = prev && prev.lastCaptureAt ? prev.declared : null;
  const row = {
    publishTime: pt,
    title: (data.video || {}).title || "",
    declared: data.declared ?? null,
    commentCount: data.declared ?? null,
    prevCommentCount: prevCount,
    level1: s.level1 ?? null,
    readable: s.authorRepliedThreads ?? null,
    awaiting: s.awaitingThreads ?? null,
    complete: !!s.complete,
    firstSeenAt: prev ? prev.firstSeenAt : now,
    lastSeenAt: now,
    lastCaptureAt: now,
  };
  if (i >= 0) rows[i] = { ...rows[i], ...row };
  else rows.push(row);
  writeVideos(id, rows);

  return { ok: true, publishTime: pt, isNew: i < 0, commentCount: row.commentCount, awaiting: row.awaiting };
}

/** 只更新索引（不抓取），用于从视频列表快速建初始索引 */
function upsertFromList(id, feed) {
  const pt = publishKey({ time: feed.time });
  if (!pt) return null;
  const rows = readVideos(id);
  const i = rows.findIndex((r) => r.publishTime === pt);
  const now = new Date().toISOString();
  const count = Number(feed.commentCount) || null;
  if (i >= 0) {
    rows[i] = { ...rows[i], title: feed.title || rows[i].title, lastSeenAt: now };
  } else {
    rows.push({
      publishTime: pt,
      title: feed.title || "",
      declared: count,
      commentCount: count,
      prevCommentCount: null,
      level1: null,
      readable: null,
      awaiting: null,
      complete: null,
      firstSeenAt: now,
      lastSeenAt: now,
      lastCaptureAt: null,
    });
  }
  writeVideos(id, rows);
  return pt;
}

function readSnapshot(id, pt) {
  const f = path.join(videoDir(id, pt), "latest.json");
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

/** 追加处理记录（只追加，不改写） */
function appendState(id, pt, entries) {
  if (!entries || !entries.length) return;
  const f = path.join(videoDir(id, pt), "state.jsonl");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const body = entries.map((e) => JSON.stringify({ ...e, at: e.at || new Date().toISOString() })).join("\n") + "\n";
  fs.appendFileSync(f, body, "utf8");
}

/** 读处理记录，按 fp 取最新一条 */
function readState(id, pt) {
  const f = path.join(videoDir(id, pt), "state.jsonl");
  if (!fs.existsSync(f)) return new Map();
  const m = new Map();
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      m.set(e.fp, e);
    } catch {}
  }
  return m;
}

/** 按显示名反查账号 id（精确优先，其次包含） */
function findAccountByName(name) {
  const want = String(name || "").trim();
  if (!want) return null;
  const ids = fs.existsSync(ROOT)
    ? fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];
  const all = ids.map((id) => readAccount(id)).filter(Boolean);
  const exact = all.find((a) => String(a.displayName || "").trim() === want);
  if (exact) return exact.id;
  const loose = all.find((a) => {
    const d = String(a.displayName || "").trim();
    return d && (want.includes(d) || d.includes(want));
  });
  return loose ? loose.id : null;
}

module.exports = {
  ROOT,
  accDir,
  videoDir,
  publishKey,
  commentFp,
  ensureAccount,
  readAccount,
  findAccountByName,
  readVideos,
  writeVideos,
  ingestCapture,
  upsertFromList,
  readSnapshot,
  appendState,
  readState,
};
