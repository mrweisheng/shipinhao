#!/usr/bin/env node
/**
 * probe-stall-inspect.js — 复现懒加载停住，并 dump 停住瞬间的 DOM 线索
 *
 * 用法：node scripts/probe-stall-inspect.js --times 8 --nth 150
 * 只有真的停住（连续 15s 无新增）才会停下 dump。
 */

const cdp = require("./lib/cdp");
const nav = require("./lib/nav");
const channels = require("./lib/channels");

const argv = process.argv.slice(2);
const getArg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const TIMES = Number(getArg("times", "8"));
const AWAY = getArg("away", "https://channels.weixin.qq.com/platform/post/draftListManager");

const DUMP = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return { error: "shadowRoot 不存在" };
  const feeds = [...root.querySelectorAll(".comment-feed-wrap")];
  const last = feeds[feeds.length - 1];
  const wrap = last ? last.parentElement : null;
  let sc = wrap;
  while (sc && sc !== root && !(sc.scrollHeight > sc.clientHeight + 20)) sc = sc.parentElement;

  // 列表容器里，最后一项之后的兄弟节点（通常是「加载中 / 没有更多」）
  const after = [];
  if (last) {
    let n = last.nextElementSibling;
    for (let i = 0; n && i < 4; i++, n = n.nextElementSibling) {
      after.push({ tag: n.tagName.toLowerCase(), cls: String(n.className || "").slice(0, 60),
                   text: (n.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 80),
                   h: Math.round(n.getBoundingClientRect().height) });
    }
  }

  // 全部含「加载/更多/重试/没有」的可见文本
  const hints = [];
  for (const el of root.querySelectorAll("*")) {
    const t = (el.innerText || "").replace(/\\s+/g, " ").trim();
    if (t.length > 40) continue;
    if (!/加载|更多|重试|没有|到底/.test(t)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 5 || r.height < 5) continue;
    hints.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 50), text: t });
    if (hints.length >= 10) break;
  }

  return {
    count: feeds.length,
    wrapCls: wrap ? String(wrap.className || "").slice(0, 60) : null,
    wrapKids: wrap ? wrap.children.length : null,
    scCls: sc && sc !== root ? String(sc.className || "").slice(0, 60) : null,
    scroll: sc && sc !== root ? [Math.round(sc.scrollTop), Math.round(sc.scrollHeight), Math.round(sc.clientHeight)] : null,
    after,
    hints,
    vis: document.visibilityState,
    focus: document.hasFocus(),
  };
})()`;

(async () => {
  for (let t = 1; t <= TIMES; t++) {
    // 回到评论页
    const pages = await cdp.listPages(9222);
    const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
    const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);

    try {
      await cdp.ensureVisible(send);
      const u = await cdp.evaluate(send, "location.href");
      if (!u.includes("/interaction/comment")) {
        await nav.clickMenuPath(send, "互动管理", "评论");
        await cdp.sleep(1500);
      }
      await cdp.evaluate(send, `location.href = ${JSON.stringify(AWAY)}`);
      for (let k = 0; k < 60; k++) {
        await cdp.sleep(300);
        if (await cdp.evaluate(send, `document.querySelectorAll(".finder-ui-desktop-menu__link").length > 4`).catch(() => false)) break;
      }
      await nav.clickMenuPath(send, "互动管理", "评论");
      await channels.ensureVideoTab(send);
      for (let k = 0; k < 80; k++) {
        const st = await cdp.evaluate(send, channels.LIST_STATE).catch(() => null);
        if (st && st.count > 0) break;
        await cdp.sleep(300);
      }

      let lastGrowth = Date.now();
      let count = 0;
      for (let k = 0; k < 60; k++) {
        const st = await cdp.evaluate(send, channels.LIST_STATE).catch(() => null);
        if (st && st.count > 0) { count = st.count; break; }
        await cdp.sleep(400);
      }
      if (!count) { console.log(`第 ${t} 次：列表未渲染，跳过`); continue; }
      let stalled = false;

      for (let i = 0; i < 40 && !stalled; i++) {
        const before = count;
        await cdp.evaluate(send, `(() => {
          const host = document.querySelector("wujie-app");
          const root = host && host.shadowRoot;
          if (!root) return false;
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
          const host = document.querySelector("wujie-app");
          const root = host && host.shadowRoot;
          if (!root) return false;
          const first = root.querySelector(".comment-feed-wrap");
          let el = first && first.parentElement;
          while (el && el !== root) {
            if (el.scrollHeight > el.clientHeight + 20) { el.scrollTop = el.scrollHeight; return true; }
            el = el.parentElement;
          }
          return false;
        })()`);

        const deadline = Date.now() + 6000;
        while (Date.now() < deadline) {
          await cdp.sleep(120);
          const st = await cdp.evaluate(send, channels.LIST_STATE).catch(() => null);
          if (st && st.count > before) { count = st.count; break; }
        }
        if (count > before) { lastGrowth = Date.now(); continue; }
        if (Date.now() - lastGrowth > 15000) stalled = true;
      }

      if (!stalled) {
        console.log(`第 ${t} 次：正常（${count} 条）`);
      } else {
        console.log(`\n第 ${t} 次：✗ 停住（${count} 条）—— DOM 线索：`);
        console.log(JSON.stringify(await cdp.evaluate(send, DUMP), null, 2));
        break;
      }
    } finally {
      close();
    }
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
