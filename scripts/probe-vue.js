#!/usr/bin/env node
/**
 * probe-vue.js — 看「展开更多回复」按钮所属 Vue 组件的上下文
 */

const cdp = require("./lib/cdp");

const EXPR = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  const btn = [...root.querySelectorAll(".load-more__btn")][0];
  if (!btn) return { error: "no btn" };

  const pick = (el) => {
    const comp = el.__vueParentComponent;
    if (!comp) return null;
    const ctx = comp.ctx || {};
    const keys = Object.keys(ctx).slice(0, 120);
    const fns = keys.filter((k) => typeof ctx[k] === "function").map((k) => ({
      k,
      src: String(ctx[k]).replace(/\\s+/g, " ").slice(0, 200),
    }));
    return {
      type: comp.type && (comp.type.name || comp.type.__name || String(comp.type).slice(0, 40)),
      props: comp.props ? Object.keys(comp.props) : null,
      ctxKeys: keys,
      fns,
    };
  };

  return {
    vei: btn._vei ? Object.keys(btn._vei) : null,
    veiParent: btn.parentElement && btn.parentElement._vei ? Object.keys(btn.parentElement._vei) : null,
    btnComp: pick(btn),
    parentComp: pick(btn.closest(".comment-item") || btn),
    attrs: [...btn.attributes].map((a) => a.name + "=" + a.value.slice(0, 40)),
  };
})()`;

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);
  try {
    const d = await cdp.evaluate(send, EXPR);
    console.log(JSON.stringify(d, null, 2).slice(0, 8000));
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
