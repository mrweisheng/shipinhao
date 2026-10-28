/**
 * lib/layout-map.js — 页面结构自检 + 定位纠错
 *
 * 目的：
 *   - 把「哪些元素是判断依据」集中成一张表，避免散落在各脚本里
 *   - 页面改版导致某个选择器失效时，不是干巴巴报错，而是给出**候选元素**
 *     （按 class 关键词打分），方便立刻找到新的定位方式并更新这里
 *
 * 判定分三类：
 *   required   必须存在，缺失 = 结构坏了
 *   optional   视场景出现（如 0 评论时没有 .comment-count__tips、无折叠时没有 .load-more__btn）
 *   context    只在「已打开某个视频」时存在（详情头部）
 */

const SPEC = [
  // 页面骨架
  { key: "shadowHost", root: "doc", sel: "wujie-app", required: true, desc: "微前端宿主" },
  // 侧边栏（导航）
  { key: "menuItem", root: "doc", sel: ".finder-ui-desktop-menu__link", required: true, desc: "侧边栏菜单项", keywords: ["menu"] },
  { key: "menuPopup", root: "doc", sel: ".finder-ui-desktop-menu__popup_menu", required: false, desc: "侧边栏弹出菜单（悬停时）", keywords: ["popup"] },
  // 页头账号区（判断「现在是谁」；在任何后台页面都在，不依赖评论页）
  { key: "accountName", root: "doc", sel: ".account-info .name", required: true, desc: "当前账号名（页头）", keywords: ["account", "name", "nick"] },
  // 列表区
  { key: "videoTab", root: "shadow", sel: "li.weui-desktop-tab__nav", required: true, desc: "视频/图文 tab", keywords: ["tab"] },
  { key: "feedList", root: "shadow", sel: ".comment-feed-wrap", required: true, desc: "视频列表项", keywords: ["feed"] },
  { key: "feedNums", root: "shadow", sel: ".feeds-nums", required: true, desc: "列表总数（共N个）", keywords: ["nums", "feed"] },
  // 详情区
  { key: "detailHeader", root: "shadow", sel: ".feed-selected-info", required: false, context: true, desc: "当前视频头部", keywords: ["selected", "info"] },
  { key: "detailTitle", root: "shadow", sel: ".feed-selected-info .feed-title", required: false, context: true, desc: "当前视频标题" },
  { key: "detailTime", root: "shadow", sel: ".feed-selected-info .feed-time", required: false, context: true, desc: "当前视频发布时间" },
  { key: "commentWrap", root: "shadow", sel: ".feed-comment__wrp", required: false, context: true, desc: "评论区容器", keywords: ["comment"] },
  { key: "commentCount", root: "shadow", sel: ".comment-count__tips", required: false, context: true, conditional: true, desc: "评论总数（共N条评论）", keywords: ["count"] },
  { key: "commentItem", root: "shadow", sel: ".comment-item", required: false, context: true, conditional: true, desc: "单条评论", keywords: ["comment"] },
  { key: "commentRow", root: "shadow", sel: ".comment-row", required: false, context: true, conditional: true, desc: "评论行（含作者标识）", keywords: ["comment"] },
  { key: "collapseBtn", root: "shadow", sel: ".load-more__btn", required: false, context: true, conditional: true, desc: "折叠回复按钮（展开更多回复）", keywords: ["load-more", "loadmore", "more"] },
];

const CHECK_EXPR = `(() => {
  const defs = ${JSON.stringify(SPEC)};
  const host = document.querySelector("wujie-app");
  const sr = host && host.shadowRoot;
  const rootOf = (r) => (r === "doc" ? document : (sr || null));

  const out = {};
  for (const d of defs) {
    const root = rootOf(d.root);
    if (!root) { out[d.key] = { count: 0, visible: 0, sample: [], note: "shadowRoot 不存在" }; continue; }
    let els;
    try { els = [...root.querySelectorAll(d.sel)]; }
    catch (e) { out[d.key] = { count: 0, visible: 0, sample: [], note: "选择器非法: " + e.message }; continue; }
    const vis = els.filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 || r.height > 0;
    });
    out[d.key] = {
      count: els.length,
      visible: vis.length,
      sample: vis.slice(0, 2).map((e) => {
        const r = e.getBoundingClientRect();
        return {
          tag: e.tagName.toLowerCase(),
          cls: String(e.className || "").slice(0, 50),
          text: (e.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 40),
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        };
      }),
    };
  }

  // 缺失项：在 shadowRoot 里按 class 关键词找候选，帮忙定位新版结构
  const candidates = {};
  if (sr) {
    const all = [...sr.querySelectorAll("*")];
    for (const d of defs) {
      if (!d.keywords) continue;
      if (out[d.key] && out[d.key].count > 0) continue;
      const scored = [];
      for (const el of all) {
        const c = String(el.className || "").toLowerCase();
        if (!c) continue;
        let score = 0;
        for (const k of d.keywords) if (c.includes(k)) score++;
        if (!score) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 5 || r.height < 5) continue;
        scored.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className || "").slice(0, 60),
          text: (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 30),
          score,
          area: Math.round(r.width * r.height),
        });
      }
      scored.sort((a, b) => b.score - a.score || a.area - b.area);
      candidates[d.key] = scored.slice(0, 6);
    }
  }

  return {
    url: location.href,
    host: !!host,
    shadow: !!sr,
    items: out,
    candidates,
  };
})()`;

/** 只做检查，返回原始结果 */
async function check(send) {
  const cdp = require("./cdp");
  return cdp.evaluate(send, CHECK_EXPR);
}

/**
 * 汇总：哪些必须项缺失、哪些候选项可用。
 * @param {object} raw check() 的返回
 * @param {object} opt  { context: 是否已打开视频（决定 context 项是否必须） }
 */
function summarize(raw, { context = false } = {}) {
  const failures = [];
  const notes = [];

  if (!raw) return { ok: false, failures: [{ key: "page", desc: "页面无响应" }], notes };
  if (!raw.host) failures.push({ key: "shadowHost", desc: "找不到 <wujie-app>：可能不在后台页面" });
  if (!raw.shadow) failures.push({ key: "shadow", desc: "拿不到 shadowRoot：微前端未挂载完或结构变更" });

  for (const d of SPEC) {
    const it = raw.items[d.key] || { count: 0, visible: 0 };
    const missing = it.count === 0;
    if (!missing) continue;

    if (d.required) {
      failures.push({ key: d.key, desc: d.desc, sel: d.sel, candidates: raw.candidates[d.key] || [] });
    } else if (d.conditional) {
      // 取决于数据：0 评论时没有评论项/评论总数，没有折叠回复时没有折叠按钮
      notes.push(`· ${d.desc}（${d.sel}）未找到 —— 本视频可能本来就没有（0 评论 / 无折叠回复）`);
    } else if (d.context && context) {
      // 已打开视频却缺详情/评论容器 —— 视为异常，但单独标注
      failures.push({ key: d.key, desc: d.desc, sel: d.sel, soft: true, candidates: raw.candidates[d.key] || [] });
    } else {
      notes.push(`· ${d.desc}（${d.sel}）当前不适用：${d.context ? "尚未打开视频" : "此场景本来就没有"}`);
    }
  }

  return { ok: failures.length === 0, failures, notes };
}

/** 打印一份人能直接照着改的清单 */
function print(raw, { context = false, log = console.log } = {}) {
  const s = summarize(raw, { context });
  if (!raw) {
    log("✗ 页面无响应（CDP evaluate 失败）");
    return s;
  }

  log(`页面：${raw.url}`);
  log(`骨架：<wujie-app> ${raw.host ? "✓" : "✗"}   shadowRoot ${raw.shadow ? "✓" : "✗"}`);
  log("");
  for (const d of SPEC) {
    const it = raw.items[d.key] || {};
    const n = it.count || 0;
    const mark = n > 0 ? "✓" : d.required ? "✗" : "–";
    const extra = n > 0 ? `×${n}` : "未找到";
    const sample = it.sample && it.sample[0] ? `  「${it.sample[0].text || it.sample[0].cls}」` : "";
    log(`  ${mark} ${d.desc.padEnd(22, " ")} ${d.sel.padEnd(42, " ")} ${extra}${sample}`);
  }

  if (s.failures.length) {
    log("\n需要纠正的定位：");
    for (const f of s.failures) {
      log(`  ✗ ${f.desc}${f.sel ? `（${f.sel}）` : ""}${f.soft ? "  [场景内缺失]" : ""}`);
      const cands = f.candidates || [];
      if (cands.length) {
        log("    同区域候选（class 关键词匹配，按可能性排序）：");
        for (const c of cands) {
          log(`      <${c.tag}> .${c.cls}  「${c.text}」  ${c.area}px²`);
        }
        log("    → 从候选中确认真实结构后，更新 lib/layout-map.js 的 SPEC 与对应脚本的选择器");
      } else {
        log("    没有同类候选：页面可能整体改版，请先用 probe-*.js 重新观察 DOM");
      }
    }
  } else {
    log("\n✓ 关键定位都在");
  }

  if (s.notes.length) {
    log("\n不适用项（不是故障）：");
    s.notes.forEach((n) => log("  " + n));
  }
  return s;
}

module.exports = { SPEC, CHECK_EXPR, check, summarize, print };
