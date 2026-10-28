#!/usr/bin/env node
/**
 * probe-comment-network.js — 打开第 N 条视频，慢慢滚评论，记录：
 *   - 评论条数 / 声明数随时间的变化
 *   - 所有评论相关请求（URL / 状态 / 返回体大小）
 *   - .load-more（展开更多回复 + spinner）的出现与消失
 *
 * 用法：node scripts/probe-comment-network.js --nth 169
 */

const cdp = require("./lib/cdp");
const channels = require("./lib/channels");

const argv = process.argv.slice(2);
const getArg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const NTH = Number(getArg("nth", "169"));

const STATE = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return null;
  const tips = root.querySelector(".comment-count__tips");
  const wrp = root.querySelector(".feed-comment__wrp");
  let sc = wrp;
  while (sc && sc !== root && !(sc.scrollHeight > sc.clientHeight + 20)) sc = sc.parentElement;
  return {
    items: root.querySelectorAll(".comment-item").length,
    tip: tips ? (tips.innerText || "").trim() : null,
    loadMore: root.querySelectorAll(".load-more").length,
    spinner: root.querySelectorAll(".load-more img.infinite-spin").length,
    scroll: sc && sc !== root ? [Math.round(sc.scrollTop), Math.round(sc.scrollHeight), Math.round(sc.clientHeight)] : null,
    vis: document.visibilityState,
    focus: document.hasFocus(),
  };
})()`;

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  const { send, on, close } = await cdp.attach(page.webSocketDebuggerUrl);

  const requests = [];
  try {
    await send("Network.enable", {}).catch(() => {});
    on("Network.requestWillBeSent", (p) => {
      if (/comment|reply|interaction/i.test(p.request.url)) {
        requests.push({ id: p.requestId, method: p.request.method, url: p.request.url.slice(0, 200), t: Date.now() });
      }
    });
    on("Network.responseReceived", (p) => {
      const r = requests.find((x) => x.id === p.requestId);
      if (r) { r.status = p.response.status; r.mime = p.response.mimeType; }
    });
    on("Network.loadingFinished", (p) => {
      const r = requests.find((x) => x.id === p.requestId);
      if (r) r.bytes = p.encodedDataLength;
    });
    on("Network.loadingFailed", (p) => {
      const r = requests.find((x) => x.id === p.requestId);
      if (r) { r.failed = p.errorText; r.blocked = p.blockedReason; }
    });

    await cdp.ensureVisible(send);

    // 重新加载，保证从这个视频的干净状态开始
    console.log("重载页面…");
    await cdp.evaluate(send, "location.reload()").catch(() => {});
    await cdp.sleep(1500);
    for (let i = 0; i < 60; i++) {
      const st = await cdp.evaluate(send, channels.LIST_STATE).catch(() => null);
      if (st && st.count > 0) break;
      await cdp.sleep(500);
    }
    await channels.ensureVideoTab(send);
    console.log("滚动列表到第", NTH, "条…");
    await channels.ensureListedWithRecovery(send, NTH, { log: (s) => console.log("  " + s) });
    await cdp.sleep(800);

    // 点开第 N 条
    const rect = await cdp.evaluate(send, `(() => {
      const host = document.querySelector("wujie-app");
      const root = host && host.shadowRoot;
      const el = [...root.querySelectorAll(".comment-feed-wrap")][${NTH - 1}];
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    await cdp.sleep(500);
    await cdp.clickAt(send, rect.x, rect.y);
    console.log("已点击，等评论区…");

    for (let i = 0; i < 40; i++) {
      const st = await cdp.evaluate(send, STATE).catch(() => null);
      if (st && st.items > 0) { console.log("评论区就绪：", JSON.stringify(st)); break; }
      await cdp.sleep(400);
    }

    // 慢慢滚：每轮滚一屏，停 2s，记录
    for (let i = 0; i < 25; i++) {
      await cdp.evaluate(send, `(() => {
        const host = document.querySelector("wujie-app");
        const root = host && host.shadowRoot;
        const wrp = root && root.querySelector(".feed-comment__wrp");
        if (!wrp) return false;
        let sc = wrp;
        while (sc && sc !== root && !(sc.scrollHeight > sc.clientHeight + 20)) sc = sc.parentElement;
        if (!sc || sc === root) return false;
        sc.scrollTop = Math.min(sc.scrollHeight, sc.scrollTop + Math.max(200, sc.clientHeight * 0.8));
        return true;
      })()`);
      await cdp.sleep(2000);
      const st = await cdp.evaluate(send, STATE).catch(() => null);
      console.log(`滚动#${i} ${JSON.stringify(st)}`);
      if (st && st.tip) {
        const m = st.tip.match(/(\d+)/);
        if (m && st.items >= Number(m[1])) { console.log("已达到声明数"); break; }
      }
    }

    console.log("\n评论相关请求：");
    for (const r of requests) {
      console.log(`  ${r.status || (r.failed ? "FAILED:" + (r.failed || r.blocked) : "?")} ${r.method} ${r.url}${r.bytes ? ` (${r.bytes}B)` : ""}`);
    }
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
