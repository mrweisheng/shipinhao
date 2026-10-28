#!/usr/bin/env node
/**
 * probe-expand-listeners.js — 看「展开更多回复」按钮上挂了哪些事件监听
 */

const cdp = require("./lib/cdp");

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);

  const evalObj = async (expr, group) => {
    const r = await send("Runtime.evaluate", {
      expression: expr,
      objectGroup: group,
      includeCommandLineAPI: false,
      returnByValue: false,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result;
  };

  try {
    await cdp.ensureVisible(send);
    const info = await cdp.evaluate(send, `(() => {
      const host = document.querySelector("wujie-app");
      const root = host && host.shadowRoot;
      const b = [...root.querySelectorAll(".load-more__btn")][0];
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      return {
        html: b.outerHTML.slice(0, 300),
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        pointerEvents: cs.pointerEvents,
        display: cs.display,
        visibility: cs.visibility,
        opacity: cs.opacity,
        parentHtml: b.parentElement.outerHTML.slice(0, 400),
      };
    })()`);
    console.log("按钮信息：");
    console.log(JSON.stringify(info, null, 2));

    for (const sel of [".load-more__btn", ".load-more"]) {
      const obj = await evalObj(`(() => {
        const host = document.querySelector("wujie-app");
        const root = host && host.shadowRoot;
        return root.querySelector(${JSON.stringify(sel)});
      })()`, "probe");
      if (!obj || !obj.objectId) { console.log(`\n${sel}: 找不到`); continue; }
      const lr = await send("DOMDebugger.getEventListeners", { objectId: obj.objectId });
      console.log(`\n${sel} 的监听器：`);
      for (const l of lr.listeners || []) {
        console.log(`  ${l.type}  useCapture=${l.useCapture}  passive=${l.passive}  handler=${(l.handler && l.handler.description || "").slice(0, 80)}`);
      }
      await send("Runtime.releaseObjectGroup", { objectGroup: "probe" }).catch(() => {});
    }

    // 看一下整个 load-more 容器内是否有别的元素覆盖
    const rect = info.rect;
    const x = rect[0] + rect[2] / 2;
    const y = rect[1] + rect[3] / 2;
    const hitStack = await cdp.evaluate(send, `(() => {
      const host = document.querySelector("wujie-app");
      const root = host && host.shadowRoot;
      const out = [];
      const el = root.elementFromPoint(${x}, ${y});
      let e = el;
      for (let i = 0; e && i < 6; i++, e = e.parentElement) {
        out.push({ tag: e.tagName.toLowerCase(), cls: String(e.className || "").slice(0, 40) });
      }
      return out;
    })()`);
    console.log("\n命中栈：", JSON.stringify(hitStack));
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
