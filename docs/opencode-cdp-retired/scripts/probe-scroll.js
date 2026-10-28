#!/usr/bin/env node
/**
 * probe-scroll.js — 重载后按真人节奏滚动，测最大可加载条数
 *
 * 节奏：每次滚 0.8 屏，间隔 1.2s，每 3 次打印进度。
 */

const cdp = require("./lib/cdp");

const READY = `(() => {
  const root = document.querySelector("wujie-app") && document.querySelector("wujie-app").shadowRoot;
  return root ? root.querySelectorAll(".comment-feed-wrap").length : 0;
})()`;

const STATE = `(() => {
  const root = document.querySelector("wujie-app").shadowRoot;
  const box = root.querySelector(".scroll-list__wrp");
  return {
    count: root.querySelectorAll(".comment-feed-wrap").length,
    top: box ? Math.round(box.scrollTop) : null,
    h: box ? Math.round(box.scrollHeight) : null,
    client: box ? Math.round(box.clientHeight) : null,
    atBottom: box ? box.scrollTop + box.clientHeight >= box.scrollHeight - 8 : null,
  };
})()`;

const PAGE_DOWN = `(() => {
  const root = document.querySelector("wujie-app").shadowRoot;
  const box = root.querySelector(".scroll-list__wrp");
  if (!box) return false;
  box.scrollTop = Math.min(box.scrollHeight, box.scrollTop + box.clientHeight * 0.8);
  return true;
})()`;

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("interaction/comment"));
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);
  try {
    console.log("重载页面…");
    await send("Page.reload", {});
    await cdp.sleep(3000);

    let n = 0;
    for (let i = 0; i < 60; i++) {
      n = await cdp.evaluate(send, READY);
      if (n > 0) break;
      await cdp.sleep(300);
    }
    console.log(`重载后首屏 ${n} 条\n`);

    let last = n;
    let stuck = 0;
    for (let i = 0; i < 80; i++) {
      await cdp.evaluate(send, PAGE_DOWN);
      await cdp.sleep(1200);
      const s = await cdp.evaluate(send, STATE);

      if ((i + 1) % 3 === 0) {
        console.log(`  第${String(i + 1).padStart(2)}步  条数=${s.count}  top=${s.top}/${s.h} 底=${s.atBottom}`);
      }

      if (s.count > last) { last = s.count; stuck = 0; }
      else if (s.atBottom) { stuck++; }

      if (stuck >= 6) { console.log(`\n→ 连续 6 步到底且无增长，停在 ${s.count} 条`); break; }
      if (s.count >= 169) { console.log(`\n→ 已全部加载 ${s.count} 条`); break; }
    }
    const end = await cdp.evaluate(send, STATE);
    console.log(`\n最终：${end.count} / 169 条`);
  } finally {
    close();
  }
})().catch((e) => { console.error("[失败] " + e.message); process.exit(1); });
