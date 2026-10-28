#!/usr/bin/env node
/**
 * probe-shell.js — 观察后台不同路由下的「外壳」结构
 *
 * 背景：直接改 location.href 到某些路由后，脚本找不到 wujie-app / 侧边栏。
 * 这里对比多个路由的：body 直接子元素、iframe、shadow 宿主、菜单是否存在。
 */

const cdp = require("./lib/cdp");

const ROUTES = [
  "/platform/interaction/comment",
  "/platform/post/music",
  "/platform/post/list",
  "/platform/home",
  "/platform/userProfileManager",
];

const INSPECT = `(() => {
  const bodyKids = [...document.body.children].map((e) => ({
    tag: e.tagName.toLowerCase(),
    id: e.id || null,
    cls: String(e.className || "").slice(0, 50),
    w: Math.round(e.getBoundingClientRect().width),
    h: Math.round(e.getBoundingClientRect().height),
  }));
  const hosts = [...document.querySelectorAll("*")].filter((e) => e.shadowRoot).map((e) => ({
    tag: e.tagName.toLowerCase(),
    id: e.id || null,
    cls: String(e.className || "").slice(0, 40),
    kids: e.shadowRoot.children.length,
    textLen: (e.shadowRoot.textContent || "").length,
  }));
  return {
    url: location.href,
    ready: document.readyState,
    title: document.title,
    bodyTextLen: (document.body.innerText || "").length,
    bodyHead: (document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 120),
    bodyKids,
    shadowHosts: hosts,
    iframes: [...document.querySelectorAll("iframe")].map((f) => ({ src: (f.src || "").slice(0, 80), w: f.clientWidth, h: f.clientHeight })),
    menuLinks: document.querySelectorAll(".finder-ui-desktop-menu__link").length,
    wujie: !!document.querySelector("wujie-app"),
  };
})()`;

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  if (!page) throw new Error("不在后台页面");
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);

  try {
    for (const route of ROUTES) {
      await cdp.evaluate(send, `location.href = "https://channels.weixin.qq.com${route}"`);
      // 给足时间：直接改地址会整页重载
      for (let i = 0; i < 20; i++) {
        await cdp.sleep(500);
        const r = await Promise.race([
          cdp.evaluate(send, `({ url: location.href, rs: document.readyState, w: !!document.querySelector("wujie-app"), m: document.querySelectorAll(".finder-ui-desktop-menu__link").length })`),
          new Promise((res) => setTimeout(() => res(null), 1500)),
        ]).catch(() => null);
        if (r && r.rs === "complete" && (r.w || r.m)) break;
      }
      const info = await cdp.evaluate(send, INSPECT).catch((e) => ({ error: e.message }));
      console.log(`\n=== ${route} ===`);
      console.log(JSON.stringify(info, null, 2).slice(0, 2600));
    }
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
