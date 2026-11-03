#!/usr/bin/env node
/**
 * probe-viewport.js — 验证「换屏幕尺寸」后页面结构是否仍然可用
 *
 * 不改变真实窗口大小，只用 CDP Emulation.setDeviceMetricsOverride 模拟视口，
 * 检查关键结构（视频列表 / 评论区容器 / 命中检测）在各尺寸下是否都在。
 *
 * 用法：node scripts/probe-viewport.js
 */

const cdp = require("./lib/cdp");

const SIZES = [
  [1024, 640],
  [1280, 720],
  [1366, 768],
  [1536, 864],
  [1920, 1080],
  [2560, 1440],
];

const CHECK = `(() => {
  const root = document.querySelector("wujie-app") && document.querySelector("wujie-app").shadowRoot;
  if (!root) return { error: "shadowRoot 不存在" };

  const feeds = [...root.querySelectorAll(".comment-feed-wrap")];
  const nums = root.querySelector(".feeds-nums");
  const wrp = root.querySelector(".feed-comment__wrp");
  const sel = root.querySelector(".feed-selected-info");

  // 命中检测：第 2 项中心点上，shadowRoot 里命中的是不是它自己
  let hitOk = null;
  if (feeds[1]) {
    feeds[1].scrollIntoView({ block: "center" });
    const r = feeds[1].getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const h = root.elementFromPoint(x, y);
    hitOk = { inside: !!(h && feeds[1].contains(h)), x, y, tag: h ? h.tagName : null };
  }

  return {
    feeds: feeds.length,
    nums: nums ? (nums.innerText || "").trim() : null,
    commentWrap: !!wrp,
    commentWrapW: wrp ? Math.round(wrp.getBoundingClientRect().width) : null,
    headerVisible: sel ? sel.getBoundingClientRect().width > 0 : false,
    innerW: innerWidth,
    innerH: innerHeight,
    scrollbarW: innerWidth - document.documentElement.clientWidth,
    hit: hitOk,
  };
})()`;

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("interaction/comment"));
  if (!page) throw new Error("请先进入评论管理页");
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);

  try {
    for (const [w, h] of SIZES) {
      await send("Emulation.setDeviceMetricsOverride", {
        width: w, height: h, deviceScaleFactor: 1, mobile: false,
      });
      await cdp.sleep(400);
      const r = await cdp.evaluate(send, CHECK);
      console.log(
        `${String(w).padStart(4)}x${String(h).padStart(4)}  ` +
          `列表 ${String(r.feeds).padStart(2)} 条  ${r.nums || "?"}` +
          `  评论区 ${r.commentWrap ? `有(${r.commentWrapW}px)` : "无"}` +
          `  头部 ${r.headerVisible ? "有" : "无"}` +
          `  命中 ${r.hit ? (r.hit.inside ? "✓" : "✗ " + r.hit.tag) : "?"}`
      );
    }
  } finally {
    await send("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
