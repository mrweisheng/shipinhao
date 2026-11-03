#!/usr/bin/env node
/**
 * probe-route-delay.js — 复现「点菜单后 URL 很久不变」
 * 直接改地址到重页面（默认肖像授权）→ 点「互动管理 → 评论」→ 每秒打印 URL / 列表条数
 */

const cdp = require("./lib/cdp");
const nav = require("./lib/nav");

const argv = process.argv.slice(2);
const AWAY = argv.includes("--away")
  ? argv[argv.indexOf("--away") + 1]
  : "https://channels.weixin.qq.com/platform/setting/portraitAuth/authAuthor";
const LIMIT = Number(argv.includes("--limit") ? argv[argv.indexOf("--limit") + 1] : 60);

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);

  try {
    await cdp.evaluate(send, `location.href = ${JSON.stringify(AWAY)}`);
    await cdp.sleep(8000);
    await cdp.ensureVisible(send);
    console.log("起点：", await cdp.evaluate(send, "location.href"));

    const t0 = Date.now();
    try {
      await nav.clickMenuPath(send, "互动管理", "评论", { log: (s) => console.log(`  ${s}`) });
      console.log(`点击完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      console.log(`点击失败：${e.message}`);
    }

    for (let i = 0; i <= LIMIT; i++) {
      const st = await cdp
        .evaluate(
          send,
          `(() => {
            const root = document.querySelector("wujie-app") && document.querySelector("wujie-app").shadowRoot;
            return {
              url: location.href,
              feeds: root ? root.querySelectorAll(".comment-feed-wrap").length : -1,
              vis: document.visibilityState,
              ready: document.readyState,
            };
          })()`
        )
        .catch(() => ({ url: "(evaluate 失败)", feeds: -1 }));
      if (i % 2 === 0 || st.url.includes("/interaction/comment")) {
        console.log(`+${i}s  feeds=${st.feeds}  vis=${st.vis}  ${st.url}`);
      }
      if (st.url.includes("/interaction/comment") && st.feeds > 0) {
        console.log(`✓ 已进入评论页并渲染列表，用时约 ${i}s`);
        break;
      }
      await cdp.sleep(1000);
    }
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
