#!/usr/bin/env node
/**
 * probe-comments-stall.js — 排查「评论只读到 N/M 条」的现场
 *
 * 只观察、不修改：dump 评论区容器、已渲染条数、页面声明数、
 * 所有可见的「展开/更多/加载/重试」按钮、最后一条评论及其后续兄弟节点。
 *
 * 用法：node scripts/probe-comments-stall.js
 *      node scripts/probe-comments-stall.js --scroll      # 先滚到底再看
 */

const cdp = require("./lib/cdp");

const argv = process.argv.slice(2);
const DO_SCROLL = argv.includes("--scroll");

const DUMP = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return { error: "shadowRoot 不存在" };

  const items = [...root.querySelectorAll(".comment-item")];
  const tips = root.querySelector(".comment-count__tips");
  const wrp = root.querySelector(".feed-comment__wrp");
  const sel = root.querySelector(".feed-selected-info");
  const selT = sel && sel.querySelector(".feed-title");
  const selM = sel && sel.querySelector(".feed-time");

  // 评论区滚动容器
  let sc = wrp;
  while (sc && sc !== root && !(sc.scrollHeight > sc.clientHeight + 20)) sc = sc.parentElement;

  // 全部可见「按钮/可点文本」
  const hints = [];
  for (const el of root.querySelectorAll("*")) {
    const t = (el.innerText || "").replace(/\\s+/g, " ").trim();
    if (!t || t.length > 30) continue;
    if (!/展开|更多|加载|重试|查看|收起|回复/.test(t)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 5 || r.height < 5) continue;
    hints.push({
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || "").slice(0, 50),
      text: t,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    });
    if (hints.length >= 30) break;
  }

  const last = items[items.length - 1];
  const after = [];
  if (last) {
    let n = last.nextElementSibling;
    for (let i = 0; n && i < 5; i++, n = n.nextElementSibling) {
      after.push({
        tag: n.tagName.toLowerCase(),
        cls: String(n.className || "").slice(0, 60),
        text: (n.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 100),
        h: Math.round(n.getBoundingClientRect().height),
      });
    }
  }

  return {
    url: location.href,
    video: {
      title: selT ? (selT.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 40) : null,
      time: selM ? (selM.innerText || "").trim() : null,
    },
    rendered: items.length,
    tipText: tips ? (tips.innerText || "").trim() : null,
    wrpTextLen: wrp ? (wrp.innerText || "").length : null,
    scroll: sc && sc !== root
      ? { cls: String(sc.className || "").slice(0, 60), top: Math.round(sc.scrollTop), h: Math.round(sc.scrollHeight), ch: Math.round(sc.clientHeight) }
      : null,
    vis: document.visibilityState,
    focus: document.hasFocus(),
    lastItem: last ? (last.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 120) : null,
    after,
    hints,
    loadMoreBtns: [...root.querySelectorAll(".load-more__btn")].map((e) => ({
      text: (e.innerText || "").replace(/\\s+/g, " ").trim(),
      visible: e.getBoundingClientRect().height > 0,
    })),
  };
})()`;

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  if (!page) throw new Error("不在视频号后台页面");
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);

  try {
    await cdp.ensureVisible(send);
    if (DO_SCROLL) {
      console.log("先滚到底…");
      for (let i = 0; i < 10; i++) {
        await cdp.evaluate(
          send,
          `(() => {
            const host = document.querySelector("wujie-app");
            const root = host && host.shadowRoot;
            const wrp = root && root.querySelector(".feed-comment__wrp");
            if (!wrp) return false;
            let sc = wrp;
            while (sc && sc !== root && !(sc.scrollHeight > sc.clientHeight + 20)) sc = sc.parentElement;
            if (!sc || sc === root) return false;
            sc.scrollTop = sc.scrollHeight;
            return true;
          })()`
        );
        await cdp.sleep(1200);
      }
    }
    const d = await cdp.evaluate(send, DUMP);
    console.log(JSON.stringify(d, null, 2));
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
