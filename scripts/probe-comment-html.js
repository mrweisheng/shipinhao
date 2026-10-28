#!/usr/bin/env node
/**
 * probe-comment-html.js — 打印「带展开更多回复」的整条评论 HTML（缩进美化）
 */

const cdp = require("./lib/cdp");

const EXPR = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  const btn = [...root.querySelectorAll(".load-more__btn")][0];
  if (!btn) return null;
  const item = btn.closest(".comment-item");
  if (!item) return null;
  // 简易美化：每个标签换行
  const html = item.outerHTML
    .replace(/></g, ">\\n<")
    .split("\\n")
    .map((l) => l.replace(/ data-v-[a-z0-9]+=""/g, ""))
    .join("\\n");
  return { html, text: (item.innerText || "").replace(/\\s+/g, " ").trim() };
})()`;

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);
  try {
    const d = await cdp.evaluate(send, EXPR);
    console.log("文本：", d.text);
    console.log("\nHTML：\n" + d.html);
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
