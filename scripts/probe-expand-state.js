#!/usr/bin/env node
/**
 * probe-expand-state.js — 看每个「展开更多回复」当前是「箭头」还是「转圈」
 * 并尝试点击，观察是否发请求 / 条数变化。
 */

const cdp = require("./lib/cdp");

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  const { send, on, close } = await cdp.attach(page.webSocketDebuggerUrl);

  const reqs = [];
  try {
    await send("Network.enable", {});
    on("Network.requestWillBeSent", (p) => {
      if (/comment/.test(p.request.url)) reqs.push(p.request.url.slice(0, 120));
    });

    const st = await cdp.evaluate(send, `(() => {
      const host = document.querySelector("wujie-app");
      const root = host && host.shadowRoot;
      const out = [];
      [...root.querySelectorAll(".load-more")].forEach((el, i) => {
        const img = el.querySelector("img");
        const arrow = el.querySelector(".weui-icon-outlined-arrow");
        const item = el.closest(".comment-item");
        const r = el.getBoundingClientRect();
        const cs = img ? getComputedStyle(img) : null;
        out.push({
          i,
          user: (item && item.querySelector(".comment-user-name") || {}).innerText,
          content: (item && item.querySelector(".comment-content") || {}).innerText,
          loading: !!img,
          arrow: !!arrow,
          imgClass: img ? img.className : null,
          anim: cs ? cs.animationName : null,
          rect: [Math.round(r.left), Math.round(r.top)],
        });
      });
      return { buttons: out, items: root.querySelectorAll(".comment-item").length };
    })()`);
    console.log(JSON.stringify(st, null, 2));

    if (st.buttons.length) {
      const b = st.buttons[0];
      const box = await cdp.evaluate(send, `(() => {
        const host = document.querySelector("wujie-app");
        const root = host && host.shadowRoot;
        const el = [...root.querySelectorAll(".load-more")][0];
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      await cdp.sleep(600);
      console.log("\n点击第一个按钮 @", JSON.stringify(box));
      await cdp.clickAt(send, box.x, box.y);
      await cdp.sleep(4000);
      console.log("请求：", reqs.length ? reqs : "（无）");
      const after = await cdp.evaluate(send, `(() => {
        const host = document.querySelector("wujie-app");
        const root = host && host.shadowRoot;
        return {
          items: root.querySelectorAll(".comment-item").length,
          loading: root.querySelectorAll(".load-more img").length,
          arrows: root.querySelectorAll(".load-more .weui-icon-outlined-arrow").length,
        };
      })()`);
      console.log("点击后：", JSON.stringify(after));
    }
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
