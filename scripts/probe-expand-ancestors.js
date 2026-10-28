#!/usr/bin/env node
/**
 * probe-expand-ancestors.js — 从「展开更多回复」按钮往上，逐层列出 click 监听器，
 * 并打印每层节点的关键属性，找出真正处理点击的那一层。
 */

const cdp = require("./lib/cdp");

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);

  const evalObj = async (pathExpr) => {
    const r = await send("Runtime.evaluate", {
      expression: pathExpr,
      objectGroup: "anc",
      returnByValue: false,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result;
  };

  try {
    await cdp.ensureVisible(send);

    const levels = await cdp.evaluate(send, `(() => {
      const host = document.querySelector("wujie-app");
      const root = host && host.shadowRoot;
      const btn = [...root.querySelectorAll(".load-more__btn")][0];
      if (!btn) return null;
      const out = [];
      let e = btn;
      for (let i = 0; e && i < 12; i++, e = e.parentElement) {
        out.push({
          i,
          tag: e.tagName.toLowerCase(),
          cls: String(e.className || "").slice(0, 60),
          text: (e.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 60),
        });
      }
      // 同一条评论里所有 load-more 的文案与兄弟信息
      const item = btn.closest(".comment-item");
      const mL = item ? item.querySelectorAll(".load-more__btn") : [];
      return { levels: out, loadMores: [...mL].map((x) => (x.innerText || "").trim()) };
    })()`);
    console.log("层级：");
    for (const l of levels.levels) console.log(`  #${l.i} <${l.tag}> .${l.cls}  「${l.text}」`);
    console.log("该评论内的 load-more 按钮：", JSON.stringify(levels.loadMores));

    for (const sel of [".load-more__btn", ".load-more", ".comment-main-content", ".comment-item", ".scroll-list", ".comment-reply-list"]) {
      const obj = await evalObj(`(() => {
        const host = document.querySelector("wujie-app");
        const root = host && host.shadowRoot;
        const btn = [...root.querySelectorAll(".load-more__btn")][0];
        if (!btn) return null;
        return ${JSON.stringify(sel)} === ".load-more__btn" ? btn : btn.closest(${JSON.stringify(sel)});
      })()`);
      if (!obj || !obj.objectId) { console.log(`\n${sel}: 无`); continue; }
      const lr = await send("DOMDebugger.getEventListeners", { objectId: obj.objectId, depth: 0, pierce: true });
      const cls = (lr.listeners || []).filter((l) => l.type === "click" || l.type === "mousedown" || l.type === "mouseup");
      console.log(`\n${sel}  click/mouse 监听器 ${cls.length} 个：`);
      for (const l of cls) {
        console.log(`  ${l.type}  capture=${l.useCapture}  src=${(l.scriptId || "")}:${(l.lineNumber ?? "")}  handler=${(l.handler && l.handler.description || "").slice(0, 100)}`);
      }
      await send("Runtime.releaseObjectGroup", { objectGroup: "anc" }).catch(() => {});
    }
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
