#!/usr/bin/env node
/**
 * probe-expand-hit.js — 检查「展开更多回复」按钮是否被遮挡 / 点击命中谁
 */

const cdp = require("./lib/cdp");

const PREP = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  const btns = [...root.querySelectorAll(".load-more__btn")];
  const b = btns[0];
  if (!b) return null;
  b.scrollIntoView({ block: "center" });
  const r = b.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  const hit = root.elementFromPoint(x, y);
  const info = (el) => el ? {
    tag: el.tagName.toLowerCase(),
    cls: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || "").slice(0, 80),
    text: (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 40),
    sameAsBtn: el === b,
    insideBtn: !!el.closest && !!el.closest(".load-more__btn"),
  } : null;
  return {
    box: { x, y, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] },
    hit: info(hit),
    btn: info(b),
    atBtnPoint: info(document.elementFromPoint(x, y)),
    stack: (() => {
      const out = [];
      let e = hit;
      for (let i = 0; e && i < 6; i++, e = e.parentElement) {
        out.push({ tag: e.tagName.toLowerCase(), cls: String(e.className || "").slice(0, 60) });
      }
      return out;
    })(),
  };
})()`;

const CLICK_SPAN = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  const b = [...root.querySelectorAll(".load-more__btn")][0];
  if (!b) return null;
  const r = b.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  const target = root.elementFromPoint(x, y) || b;
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }));
  }
  return { tag: target.tagName.toLowerCase(), cls: String(target.className || "").slice(0, 50), text: (target.innerText || "").trim() };
})()`;

const COUNT = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  const tips = root && root.querySelector(".comment-count__tips");
  return {
    items: root ? root.querySelectorAll(".comment-item").length : -1,
    replies: root ? root.querySelectorAll(".comment-reply-list .comment-item").length : -1,
    replyLists: root ? root.querySelectorAll(".comment-reply-list").length : -1,
    btns: root ? root.querySelectorAll(".load-more__btn").length : -1,
    tip: tips ? (tips.innerText || "").trim() : null,
  };
})()`;

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);

  try {
    await cdp.ensureVisible(send);
    console.log("命中检测：");
    console.log(JSON.stringify(await cdp.evaluate(send, PREP), null, 2));
    console.log("\n点击前：", JSON.stringify(await cdp.evaluate(send, COUNT)));

    const t = await cdp.evaluate(send, CLICK_SPAN);
    console.log("在命中元素上派发鼠标事件：", JSON.stringify(t));
    await cdp.sleep(2500);
    console.log("点击后：", JSON.stringify(await cdp.evaluate(send, COUNT)));

    // 再试：把按钮滚到视口中央，用真实 CDP 点击
    const box = await cdp.evaluate(send, `(() => {
      const host = document.querySelector("wujie-app");
      const root = host && host.shadowRoot;
      const b = [...root.querySelectorAll(".load-more__btn")][0];
      if (!b) return null;
      b.scrollIntoView({ block: "center" });
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    await cdp.sleep(700);
    if (box) {
      await cdp.clickAt(send, box.x, box.y);
      await cdp.sleep(2500);
      console.log("CDP 真实点击后：", JSON.stringify(await cdp.evaluate(send, COUNT)));
    }
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
