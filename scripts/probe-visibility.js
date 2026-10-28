#!/usr/bin/env node
/**
 * probe-visibility.js — 测试 Page.bringToFront 能否让页面恢复可见
 */

const cdp = require("./lib/cdp");

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin"));
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);
  try {
    const before = await cdp.evaluate(send, "({v:document.visibilityState, f:document.hasFocus()})");
    console.log("调用前：", JSON.stringify(before));

    const ok = await cdp.ensureVisible(send);
    const after = await cdp.evaluate(send, "({v:document.visibilityState, f:document.hasFocus()})");
    console.log("ensureVisible 返回：", ok);
    console.log("调用后：", JSON.stringify(after));
  } finally {
    close();
  }
})().catch((e) => { console.error("[失败] " + e.message); process.exit(1); });
