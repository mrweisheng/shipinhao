#!/usr/bin/env node
/**
 * probe-scroll-stall.js — 复现「列表滚到一半不再加载」
 *
 * 场景：直接改地址到一个重页面（默认草稿箱）→ 回到评论页 → 滚到第 N 条
 * 每轮打印：条数 / 滚动位置 / 容器高度 / 页面可见性 / 最后一项位置
 */

const cdp = require("./lib/cdp");
const nav = require("./lib/nav");
const channels = require("./lib/channels");

const argv = process.argv.slice(2);
const getArg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const AWAY = getArg("away", "https://channels.weixin.qq.com/platform/post/draftListManager");
const NTH = Number(getArg("nth", "150"));

const STATE = `(() => {
  const root = document.querySelector("wujie-app").shadowRoot;
  const feeds = [...root.querySelectorAll(".comment-feed-wrap")];
  const last = feeds[feeds.length - 1];
  let sc = last ? last.parentElement : null;
  while (sc && sc !== root && !(sc.scrollHeight > sc.clientHeight + 20)) sc = sc.parentElement;
  const r = last ? last.getBoundingClientRect() : null;
  const nums = root.querySelector(".feeds-nums");
  return {
    count: feeds.length,
    declared: nums ? (nums.innerText || "").replace(/\\D/g, "") : null,
    scrollTop: sc ? Math.round(sc.scrollTop) : null,
    scrollH: sc ? Math.round(sc.scrollHeight) : null,
    clientH: sc ? Math.round(sc.clientHeight) : null,
    vis: document.visibilityState,
    ready: document.readyState,
    lastRect: r ? [Math.round(r.top), Math.round(r.height)] : null,
    htmlLen: document.documentElement.outerHTML.length,
  };
})()`;

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);

  try {
    await cdp.ensureVisible(send);
    await cdp.evaluate(send, `location.href = ${JSON.stringify(AWAY)}`);
    console.log("去重页面：", AWAY);
    await cdp.sleep(6000);
    await cdp.ensureVisible(send);

    console.log("点回评论页…");
    await nav.clickMenuPath(send, "互动管理", "评论");
    for (let i = 0; i < 40; i++) {
      await cdp.sleep(300);
      const u = await cdp.evaluate(send, "location.href");
      if (u.includes("/interaction/comment")) break;
    }
    console.log("当前：", await cdp.evaluate(send, "location.href"));

    // 等列表渲染
    for (let i = 0; i < 60; i++) {
      const st = await cdp.evaluate(send, STATE).catch(() => null);
      if (st && st.count > 0) break;
      await cdp.sleep(300);
    }

    let lastCount = -1, stable = 0;
    for (let i = 0; i < 60; i++) {
      const before = await cdp.evaluate(send, STATE);
      await cdp.evaluate(send, `(() => {
        const root = document.querySelector("wujie-app").shadowRoot;
        const first = root.querySelector(".comment-feed-wrap");
        let el = first && first.parentElement;
        while (el && el !== root) {
          if (el.scrollHeight > el.clientHeight + 20) { el.scrollTop = Math.max(0, el.scrollTop - 400); return true; }
          el = el.parentElement;
        }
        return false;
      })()`);
      await cdp.sleep(120);
      await cdp.evaluate(send, `(() => {
        const root = document.querySelector("wujie-app").shadowRoot;
        const first = root.querySelector(".comment-feed-wrap");
        let el = first && first.parentElement;
        while (el && el !== root) {
          if (el.scrollHeight > el.clientHeight + 20) { el.scrollTop = el.scrollHeight; return true; }
          el = el.parentElement;
        }
        return false;
      })()`);

      let st = null;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        await cdp.sleep(150);
        st = await cdp.evaluate(send, STATE).catch(() => null);
        if (st && st.count > before.count) break;
      }

      if (!st) { console.log(`#${i} 状态读取失败`); continue; }
      console.log(
        `#${String(i).padStart(2)}  条数 ${String(st.count).padStart(3)}/${st.declared}  ` +
          `scroll ${st.scrollTop}/${st.scrollH}  视口 ${st.clientH}  可见 ${st.vis}  ` +
          `末项top ${st.lastRect ? st.lastRect[0] : "?"}`
      );

      if (st.count >= NTH) { console.log(`✓ 已到第 ${NTH} 条`); break; }
      if (st.count === lastCount) {
        stable++;
        if (stable >= 10) { console.log("✗ 连续 10 轮无增长，停止"); break; }
      } else { stable = 0; lastCount = st.count; }
    }

    const final = await cdp.evaluate(send, STATE);
    console.log("最终：", JSON.stringify(final));
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
