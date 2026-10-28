#!/usr/bin/env node
/**
 * probe-bundle.js — 在页面 JS 里找「展开更多回复」相关的组件代码
 *
 * 1) 列出页面加载的 JS（performance.getEntriesByType('resource')）
 * 2) 在页面里 fetch 这些 JS，grep "展开更多回复" / "load-more"
 * 3) 打印命中位置附近的代码片段
 */

const cdp = require("./lib/cdp");

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);

  try {
    const scripts = await cdp.evaluate(send, `(() => {
      const urls = performance.getEntriesByType("resource")
        .map((e) => e.name)
        .filter((u) => /\\.js(\\?|$)/.test(u));
      return [...new Set(urls)];
    })()`);
    console.log(`页面 JS ${scripts.length} 个`);

    const hits = await cdp.evaluate(send, `(async () => {
      const urls = ${JSON.stringify(scripts)};
      const out = [];
      for (const u of urls) {
        try {
          const r = await fetch(u, { credentials: "include" });
          if (!r.ok) continue;
          const t = await r.text();
          if (!t.includes("展开更多回复")) continue;
          const idx = [];
          let i = -1;
          while ((i = t.indexOf("展开更多回复", i + 1)) >= 0 && idx.length < 5) idx.push(i);
          out.push({
            url: u.split("?")[0].slice(-60),
            len: t.length,
            snippets: idx.map((i) => t.slice(Math.max(0, i - 500), i + 300)),
          });
        } catch (e) { /* ignore */ }
      }
      return out;
    })()`);

    for (const h of hits) {
      console.log(`\n===== ${h.url} (${h.len} chars) =====`);
      h.snippets.forEach((s, i) => {
        console.log(`\n--- 片段 ${i + 1} ---`);
        console.log(s);
      });
    }
    if (!hits.length) console.log("没有 JS 包含该文案（可能文案来自接口数据或其它域）");
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
