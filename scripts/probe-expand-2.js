#!/usr/bin/env node
/**
 * probe-expand-2.js — 点「展开更多回复」前后，dump 该评论块的结构与文本
 *
 * 目的：确认点击到底有没有生效（文案是否变「收起」、是否多出回复节点），
 * 以及回复节点用什么 class（是不是没被 .comment-item 统计到）。
 */

const cdp = require("./lib/cdp");

const INSPECT = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return { error: "no root" };

  const btn = [...root.querySelectorAll(".load-more__btn")][0];
  if (!btn) return { error: "没有 load-more__btn" };

  // 往上找到整条评论
  let item = btn.closest(".comment-item");
  const chain = [];
  let e = btn;
  for (let i = 0; e && i < 8; i++, e = e.parentElement) {
    chain.push({ tag: e.tagName.toLowerCase(), cls: String(e.className || "").slice(0, 70) });
  }

  const dump = (el) => el ? {
    cls: String(el.className || ""),
    text: (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 400),
    html: el.innerHTML.replace(/\\s+/g, " ").slice(0, 1200),
    h: Math.round(el.getBoundingClientRect().height),
  } : null;

  return {
    chain,
    renderedItems: root.querySelectorAll(".comment-item").length,
    tip: (root.querySelector(".comment-count__tips") || {}).innerText,
    loadMoreText: (btn.innerText || "").trim(),
    item: dump(item),
    parent: item ? dump(item.parentElement) : null,
    // 统计评论区所有 class 里含 reply 的元素
    replyNodes: [...root.querySelectorAll("[class*=reply]")].slice(0, 12).map((x) => ({
      cls: String(x.className || "").slice(0, 60),
      text: (x.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 60),
    })),
  };
})()`;

const CLICK = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  const btn = [...root.querySelectorAll(".load-more__btn")][0];
  if (!btn) return null;
  btn.scrollIntoView({ block: "center" });
  const r = btn.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);

  try {
    await cdp.ensureVisible(send);
    const before = await cdp.evaluate(send, INSPECT);
    console.log("=== 点击前 ===");
    console.log(JSON.stringify(before, null, 2).slice(0, 5000));

    const box = await cdp.evaluate(send, CLICK);
    await cdp.sleep(800);
    console.log("\n点击坐标：", JSON.stringify(box));
    await cdp.clickAt(send, box.x, box.y);
    await cdp.sleep(3000);

    const after = await cdp.evaluate(send, INSPECT);
    console.log("\n=== 点击后 ===");
    console.log(JSON.stringify({
      chain: after.chain,
      renderedItems: after.renderedItems,
      loadMoreText: after.loadMoreText,
      item: after.item,
      parent: after.parent,
      replyNodes: after.replyNodes,
    }, null, 2).slice(0, 6000));
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
