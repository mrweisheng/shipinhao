#!/usr/bin/env node
/**
 * probe-expand-net.js — 点「展开更多回复」时到底发没发请求
 *
 * 打开 Network 监听 → 滚动按钮进视口 → 真实点击 → 打印期间所有请求和 console 错误。
 */

const cdp = require("./lib/cdp");

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  const { send, on, close } = await cdp.attach(page.webSocketDebuggerUrl);

  try {
    await cdp.ensureVisible(send);
    await send("Network.enable", {}).catch((e) => console.log("Network.enable 失败：" + e.message));
    await send("Runtime.enable", {}).catch(() => {});

    const reqs = [];
    on("Network.requestWillBeSent", (p) => {
      if (!/\.(js|css|png|jpg|jpeg|webp|svg|woff2?|ico)/i.test(p.request.url)) {
        reqs.push({ method: p.request.method, url: p.request.url.slice(0, 160), type: p.type });
      }
    });
    on("Network.responseReceived", (p) => {
      const hit = reqs.find((r) => r.url.startsWith(p.response.url.slice(0, 160)));
      if (hit) hit.status = p.response.status;
    });
    on("Runtime.exceptionThrown", (p) => {
      console.log("页面异常：", p.exceptionDetails && (p.exceptionDetails.text || ""), p.exceptionDetails && p.exceptionDetails.exception && p.exceptionDetails.exception.description);
    });
    on("Runtime.consoleAPICalled", (p) => {
      const t = (p.args || []).map((a) => a.value || a.description || "").join(" ");
      if (t) console.log(`[console.${p.type}] ${String(t).slice(0, 200)}`);
    });

    const box = await cdp.evaluate(send, `(() => {
      const host = document.querySelector("wujie-app");
      const root = host && host.shadowRoot;
      const b = [...root.querySelectorAll(".load-more__btn")][0];
      if (!b) return null;
      b.scrollIntoView({ block: "center" });
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (b.innerText||"").trim() };
    })()`);
    console.log("按钮：", JSON.stringify(box));
    await cdp.sleep(900);

    console.log("\n点击中…");
    await cdp.clickAt(send, box.x, box.y);
    await cdp.sleep(5000);

    console.log(`\n期间请求 ${reqs.length} 条：`);
    for (const r of reqs) console.log(`  ${r.status || "?"} ${r.method} ${r.url}`);

    const st = await cdp.evaluate(send, `(() => {
      const host = document.querySelector("wujie-app");
      const root = host && host.shadowRoot;
      return {
        items: root.querySelectorAll(".comment-item").length,
        btns: root.querySelectorAll(".load-more__btn").length,
        tip: (root.querySelector(".comment-count__tips") || {}).innerText,
      };
    })()`);
    console.log("\n点击后：", JSON.stringify(st));
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
