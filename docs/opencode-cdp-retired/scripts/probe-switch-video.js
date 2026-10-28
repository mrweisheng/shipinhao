#!/usr/bin/env node
/**
 * probe-switch-video.js — 观察「点开另一条视频」时评论区如何刷新
 *
 * 目的：解决 05 的误判 —— 点完后评论区还残留上一条视频的评论，
 * 导致「已就绪：76 条」其实是旧数据。
 *
 * 这里点开第 N 条，然后每 160ms 采样一次评论区指纹，看它在什么时候变。
 *
 * 用法：node scripts/probe-switch-video.js --nth 3
 */

const cdp = require("./lib/cdp");

const argv = process.argv.slice(2);
const i = argv.indexOf("--nth");
const NTH = i >= 0 ? Number(argv[i + 1]) : 3;

const SIG = `(() => {
  const root = document.querySelector("wujie-app").shadowRoot;
  const items = [...root.querySelectorAll(".comment-item")];
  const tips = root.querySelector(".comment-count__tips");
  const first = items[0] ? (items[0].innerText || "").replace(/\\s+/g, " ").trim().slice(0, 40) : null;
  const empty = root.querySelector(".comment-empty, .no-comment");
  return {
    n: items.length,
    tips: tips ? (tips.innerText || "").trim() : null,
    first,
    empty: empty ? (empty.innerText || "").trim().slice(0, 30) : null,
    active: (() => {
      const feeds = [...root.querySelectorAll(".comment-feed-wrap")];
      const k = feeds.findIndex((f) => f.classList.contains("active-feed"));
      return k >= 0 ? k + 1 : null;
    })(),
  };
})()`;

const CLICK = (idx) => `(() => {
  const root = document.querySelector("wujie-app").shadowRoot;
  const el = root.querySelectorAll(".comment-feed-wrap")[${idx}];
  if (!el) return null;
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("interaction/comment"));
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);
  try {
    await cdp.ensureVisible(send);
    const before = await cdp.evaluate(send, SIG);
    console.log("点击前  ", JSON.stringify(before));

    const pos = await cdp.evaluate(send, CLICK(NTH - 1));
    if (!pos) throw new Error(`没有第 ${NTH} 条`);
    await cdp.clickAt(send, pos.x, pos.y);

    let prev = null;
    for (let k = 0; k < 30; k++) {
      await cdp.sleep(160);
      const s = await cdp.evaluate(send, SIG);
      const changed = prev ? (s.n !== prev.n || s.tips !== prev.tips || s.first !== prev.first) : false;
      console.log(
        `${String(k * 160).padStart(4)}ms  n=${String(s.n).padStart(3)}  tips=${s.tips}` +
          `  active=${s.active}${changed ? "  ← 变化" : ""}  | ${(s.first || s.empty || "").slice(0, 30)}`
      );
      prev = s;
    }
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
