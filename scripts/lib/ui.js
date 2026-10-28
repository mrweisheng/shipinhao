/**
 * lib/ui.js — 页面入口与关键选择器的「自适应注册表」
 *
 * 为什么要有它：
 *   平台改版会让写死的路径 / 选择器静默失效，脚本却只报一句「读不到」。
 *   这里把「怎么进评论页」「账号名在哪读」变成带多个候选、可自我修正的注册表：
 *     1. 先试登记过的候选（data/ui-map.json，lastWorking 优先）
 *     2. 候选都失效 → 用结构启发式现场找
 *     3. 找到了立刻写回 ui-map.json，下次直接用新的
 *   同时提供「已登记账号名反查」：选择器全废时，还能用账号名认出当前是谁。
 *
 * 约束：
 *   - 只认「结构 + 已登记账号名」，不写死账号、视频、评论内容。
 *   - 页面结构大改后要人工复核一遍并同步 `页面结构与操作点.md`（见该文档第 7 节）。
 */

const fs = require("fs");
const path = require("path");
const cdp = require("./cdp");

const MAP_FILE = path.join(__dirname, "..", "..", "data", "ui-map.json");
const ACCOUNTS_DIR = path.join(__dirname, "..", "..", "data", "accounts");

const DEFAULTS = {
  version: 1,
  commentPageUrl: "https://channels.weixin.qq.com/platform/interaction/comment",
  routes: {
    comment: { lastWorking: "url", menuPath: ["互动管理", "评论"], updatedAt: null },
  },
  selectors: {
    accountName: {
      candidates: [".account-info .name"],
      lastWorking: ".account-info .name",
      updatedAt: null,
    },
  },
  history: [],
};

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function merge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!patch || typeof patch !== "object") return out;
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && base && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = merge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function load() {
  try {
    if (!fs.existsSync(MAP_FILE)) return clone(DEFAULTS);
    return merge(clone(DEFAULTS), JSON.parse(fs.readFileSync(MAP_FILE, "utf8")));
  } catch {
    return clone(DEFAULTS);
  }
}

function save(map) {
  const tmp = MAP_FILE + ".tmp";
  fs.mkdirSync(path.dirname(MAP_FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), "utf8");
  fs.renameSync(tmp, MAP_FILE);
}

function note(map, kind, detail) {
  map.history = [...(map.history || []), { at: new Date().toISOString(), kind, detail }].slice(-50);
}

/** 已登记账号的显示名（用于选择器全失效时反查） */
function registeredNames() {
  try {
    return fs
      .readdirSync(ACCOUNTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        try {
          const a = JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, d.name, "account.json"), "utf8"));
          return String(a.displayName || "").trim();
        } catch {
          return "";
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 账号名 + 当前页面，一次求值拿到；找不到 selector 时给出新发现的候选 */
function accountProbeExpr() {
  const map = load();
  const cands = [];
  if (map.selectors.accountName.lastWorking) cands.push(map.selectors.accountName.lastWorking);
  for (const s of map.selectors.accountName.candidates || []) if (!cands.includes(s)) cands.push(s);
  const names = registeredNames();

  return `(() => {
  const sels = ${JSON.stringify(cands)};
  const names = ${JSON.stringify(names)};
  const url = location.href;
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => ((el.innerText || el.textContent || "") + "").replace(/\\s+/g, " ").trim();
  const selOf = (el) => {
    const cls = String(el.className || "").split(/\\s+/).filter(Boolean);
    if (!cls.length) return null;
    const p = el.parentElement;
    const pcls = p ? String(p.className || "").split(/\\s+/).filter(Boolean) : [];
    return pcls.length ? "." + pcls[0] + " ." + cls[0] : "." + cls[0];
  };
  for (const s of sels) {
    let el = null;
    try { el = document.querySelector(s); } catch (e) { continue; }
    if (!el || !vis(el)) continue;
    const t = txt(el);
    if (t) return { name: t, selector: s, method: "registered", url };
  }
  // 结构启发：账号卡片的 class 通常带 account / profile / user-info
  const boxes = [...document.querySelectorAll('[class*="account"],[class*="profile"],[class*="user-info"],[class*="userInfo"]')].filter(vis);
  for (const b of boxes) {
    const n = [...b.querySelectorAll(".name,[class*='nick'],[class*='nickname'],[class*='nickName'],[class*='Name']")].find(vis);
    const t = n && txt(n);
    if (t && t.length >= 2 && t.length <= 24 && !/^视频号|^关于/.test(t)) {
      return { name: t, selector: selOf(n), method: "heuristic", url };
    }
  }
  // 最后一道：用已登记账号名反查（叶子文本完全相等）
  if (names.length) {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = w.nextNode())) {
      const t = String(node.textContent || "").trim();
      if (!names.includes(t)) continue;
      const el = node.parentElement;
      if (!el || !vis(el)) continue;
      return { name: t, selector: selOf(el), method: "name-match", url };
    }
  }
  return { name: null, selector: null, method: null, url };
})()`;
}

/** 发现新的可用选择器 → 写回注册表 */
function rememberAccountSelector(selector, method) {
  if (!selector || !/[.#\[]/.test(selector)) return false;
  const map = load();
  const box = map.selectors.accountName;
  if (box.lastWorking === selector) return false;
  box.lastWorking = selector;
  box.candidates = [selector, ...(box.candidates || []).filter((s) => s !== selector)].slice(0, 5);
  box.updatedAt = new Date().toISOString();
  note(map, "selector", `accountName -> ${selector} (${method})`);
  save(map);
  return true;
}

function isCommentUrl(url) {
  return typeof url === "string" && /\/platform\/interaction\/comment/.test(url);
}

function commentUrl() {
  return load().commentPageUrl;
}

/** 评论页路径变了 → 更新注册表（换域名/换路径都能跟上） */
function rememberCommentUrl(actualUrl) {
  let u;
  try {
    u = new URL(actualUrl);
  } catch {
    return false;
  }
  if (!isCommentUrl(actualUrl)) return false;
  const want = u.origin + u.pathname;
  const map = load();
  if (map.commentPageUrl === want) return false;
  const old = map.commentPageUrl;
  map.commentPageUrl = want;
  map.routes.comment.updatedAt = new Date().toISOString();
  note(map, "route", `commentPageUrl: ${old} -> ${want}`);
  save(map);
  return true;
}

function rememberRoute(via) {
  const map = load();
  if (map.routes.comment.lastWorking === via) return false;
  map.routes.comment.lastWorking = via;
  map.routes.comment.updatedAt = new Date().toISOString();
  note(map, "route", `comment via ${via}`);
  save(map);
  return true;
}

/**
 * 读当前账号名。刚跳转到评论页时页头可能还没挂载，所以带一次短轮询，
 * 不要因为一瞬读不到就判定「读不到账号」。
 */
async function resolveAccountOnPage(send, { waitMs = 6000 } = {}) {
  const deadline = Date.now() + waitMs;
  let r = null;
  while (Date.now() < deadline) {
    r = await cdp.evaluate(send, accountProbeExpr());
    if (r && r.name) break;
    await cdp.sleep(300);
  }
  if (r && r.method && r.method !== "registered" && r.selector) {
    if (rememberAccountSelector(r.selector, r.method)) {
      console.error(`[ui] 账号名选择器已更新为 ${r.selector}（${r.method}），已写入 data/ui-map.json`);
    }
  }
  return r;
}

async function waitCommentPage(send, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await cdp.sleep(300);
    const st = await cdp
      .evaluate(send, `(() => ({ url: location.href, host: !!document.querySelector("wujie-app") }))()`)
      .catch(() => null);
    if (st && isCommentUrl(st.url)) return st.url;
  }
  return null;
}

/**
 * 进评论页：URL 直达优先（稳定、不依赖菜单结构），失败再用「互动管理 → 评论」兜底。
 * 成功后会记录「哪条路走通」和「真实 URL」，下次直接用。
 */
async function ensureCommentPageOnPage(send, { log = () => {}, timeoutMs = 25000 } = {}) {
  const map = load();
  const url0 = await cdp.evaluate(send, "location.href");
  if (isCommentUrl(url0)) {
    rememberCommentUrl(url0);
    return { ok: true, via: "already", url: url0 };
  }

  log(`当前不在评论页（${url0}），先试 URL 直达…`);
  await cdp.evaluate(send, `location.href = ${JSON.stringify(map.commentPageUrl)}`);
  let url1 = await waitCommentPage(send, timeoutMs);
  if (url1) {
    const changed = rememberCommentUrl(url1);
    rememberRoute("url");
    if (changed) log(`评论页路径已更新：${url1}`);
    return { ok: true, via: "url", url: url1 };
  }

  log("URL 直达未成功，改用菜单导航…");
  const nav = require("./nav");
  const [parent, child] = map.routes.comment.menuPath;
  await nav.clickMenuPath(send, parent, child, { log });
  url1 = await waitCommentPage(send, 30000);
  if (url1) {
    const changed = rememberCommentUrl(url1);
    rememberRoute("menu");
    if (changed) log(`评论页路径已更新：${url1}`);
    return { ok: true, via: "menu", url: url1 };
  }
  return { ok: false, via: null, url: await cdp.evaluate(send, "location.href").catch(() => null) };
}

module.exports = {
  MAP_FILE,
  DEFAULTS,
  load,
  save,
  registeredNames,
  accountProbeExpr,
  rememberAccountSelector,
  isCommentUrl,
  commentUrl,
  rememberCommentUrl,
  rememberRoute,
  resolveAccountOnPage,
  ensureCommentPageOnPage,
};
