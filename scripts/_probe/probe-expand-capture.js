#!/usr/bin/env node
/**
 * probe-expand-capture.js — 点击「展开更多回复」时，事件到底走到哪一层
 *
 * 在 document / shadowRoot 上装捕获监听，记录 composedPath；
 * 再真实点击，看事件是否到达、路径里有没有按钮。
 */

const cdp = require("./lib/cdp");

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);

  try {
    await cdp.ensureVisible(send);

    await cdp.evaluate(send, `(() => {
      window.__clicks = [];
      const host = document.querySelector("wujie-app");
      const root = host && host.shadowRoot;
      const rec = (where) => (e) => {
        window.__clicks.push({
          where,
          type: e.type,
          trusted: e.isTrusted,
          target: e.target && e.target.tagName,
          path: (e.composedPath ? e.composedPath() : []).slice(0, 8).map((n) => {
            if (n === window) return "window";
            if (n === document) return "document";
            return n.tagName ? n.tagName.toLowerCase() + "." + String(n.className || "").split(" ")[0] : String(n);
          }),
        });
      };
      document.addEventListener("click", rec("document-capture"), true);
      document.addEventListener("mousedown", rec("document-capture"), true);
      if (root) {
        root.addEventListener("click", rec("root-capture"), true);
        root.addEventListener("mousedown", rec("root-capture"), true);
      }
      return true;
    })()`);

    const box = await cdp.evaluate(send, `(() => {
      const host = document.querySelector("wujie-app");
      const root = host && host.shadowRoot;
      const b = [...root.querySelectorAll(".load-more__btn")][0];
      if (!b) return null;
      b.scrollIntoView({ block: "center" });
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (b.innerText || "").trim() };
    })()`);
    await cdp.sleep(800);

    console.log("按钮：", JSON.stringify(box));
    await cdp.clickAt(send, box.x, box.y);
    await cdp.sleep(2000);

    const clicks = await cdp.evaluate(send, "window.__clicks");
    console.log("\n捕获到的事件：");
    console.log(JSON.stringify(clicks, null, 2));

    const after = await cdp.evaluate(send, `(() => {
      const host = document.querySelector("wujie-app");
      const root = host && host.shadowRoot;
      return { items: root.querySelectorAll(".comment-item").length, btns: root.querySelectorAll(".load-more__btn").length };
    })()`);
    console.log("\n点击后：", JSON.stringify(after));
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
