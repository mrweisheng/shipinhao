#!/usr/bin/env node
/**
 * probe-expand.js — 验证「展开更多回复」按钮到底怎么点才有效
 *
 * 对每个 .load-more__btn：
 *   1) 先 scrollIntoView，等它进入视口
 *   2) 用 CDP 真实鼠标点击（不是 DOM .click()）
 *   3) 轮询评论条数变化
 * 打印每一步的结果。用法：node scripts/probe-expand.js
 */

const cdp = require("./lib/cdp");

const COUNT = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return null;
  const tips = root.querySelector(".comment-count__tips");
  return {
    rendered: root.querySelectorAll(".comment-item").length,
    tip: tips ? (tips.innerText || "").trim() : null,
    btns: [...root.querySelectorAll(".load-more__btn")].map((e, i) => {
      const r = e.getBoundingClientRect();
      return { i, text: (e.innerText || "").replace(/\\s+/g, " ").trim(), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
    }),
  };
})()`;

const BRING = (i) => `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  const btns = [...root.querySelectorAll(".load-more__btn")];
  const b = btns[${i}];
  if (!b) return null;
  b.scrollIntoView({ block: "center" });
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), text: (b.innerText || "").trim() };
})()`;

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);

  try {
    await cdp.ensureVisible(send);
    let st = await cdp.evaluate(send, COUNT);
    console.log(`起点：${st.rendered} 条（${st.tip}），按钮 ${st.btns.length} 个`);

    let guard = 0;
    while (guard++ < 8) {
      st = await cdp.evaluate(send, COUNT);
      if (st.btns.length === 0) { console.log("没有可展开的按钮了"); break; }

      const btn = st.btns[0];
      const box = await cdp.evaluate(send, BRING(0));
      await cdp.sleep(900);
      const box2 = await cdp.evaluate(send, COUNT);
      const b2 = await cdp.evaluate(send, `(() => {
        const host = document.querySelector("wujie-app");
        const root = host && host.shadowRoot;
        const b = [...root.querySelectorAll(".load-more__btn")][0];
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (b.innerText || "").trim() };
      })()`);
      console.log(`\n[${guard}] 按钮「${btn.text}」原位置 ${JSON.stringify(btn.rect)} → scrollIntoView 后 ${JSON.stringify(b2)}`);
      console.log(`   点击前 ${box2.rendered} 条`);

      if (!b2) break;
      await cdp.clickAt(send, b2.x, b2.y);

      let after = null;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        await cdp.sleep(300);
        after = await cdp.evaluate(send, COUNT);
        if (after.rendered > box2.rendered) break;
      }
      console.log(`   点击后 ${after.rendered} 条（按钮剩 ${after.btns.length} 个）${after.rendered > box2.rendered ? "  ✓ 新增" : "  ✗ 无变化"}`);
      if (after.rendered === box2.rendered) {
        console.log("   再试一次 DOM click()…");
        await cdp.evaluate(send, `(() => {
          const host = document.querySelector("wujie-app");
          const root = host && host.shadowRoot;
          const b = [...root.querySelectorAll(".load-more__btn")][0];
          if (b) b.click();
          return true;
        })()`);
        await cdp.sleep(3000);
        const a2 = await cdp.evaluate(send, COUNT);
        console.log(`   DOM click 后 ${a2.rendered} 条 ${a2.rendered > box2.rendered ? "  ✓ 新增" : "  ✗ 仍无变化"}`);
        if (a2.rendered === box2.rendered) break;
      }
    }

    const fin = await cdp.evaluate(send, COUNT);
    console.log(`\n最终：${fin.rendered} 条（${fin.tip}），剩 ${fin.btns.length} 个按钮`);
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
