#!/usr/bin/env node
/**
 * probe-menu.js — 观察「侧边栏收起/展开」两种状态下，悬停父菜单会发生什么
 *
 * 收起时父项只显示图标（innerText 为空），但 textContent 仍有标签名。
 * 这里验证：按 textContent 找人 → 悬停 → 对应 popup 的可见性与子项状态。
 */

const cdp = require("./lib/cdp");

const PARENT = process.argv.includes("--parent")
  ? process.argv[process.argv.indexOf("--parent") + 1]
  : "互动管理";

const FIND_PARENT = `(() => {
  const norm = (s) => (s || "").replace(/\\s+/g, "").trim();
  const target = norm(${JSON.stringify(PARENT)});
  const links = [...document.querySelectorAll(".finder-ui-desktop-menu__link")];
  const el = links.find((e) =>
    norm(e.textContent) === target &&
    e.getBoundingClientRect().width > 30 &&
    !e.closest(".finder-ui-desktop-sub-menu")
  );
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    innerText: (el.innerText || "").replace(/\\s+/g, " ").trim(),
    textContent: norm(el.textContent),
  };
})()`;

const POPUP = `(() => {
  const norm = (s) => (s || "").replace(/\\s+/g, "").trim();
  const target = norm(${JSON.stringify(PARENT)});
  const links = [...document.querySelectorAll(".finder-ui-desktop-menu__link")];
  const el = links.find((e) =>
    norm(e.textContent) === target &&
    e.getBoundingClientRect().width > 30 &&
    !e.closest(".finder-ui-desktop-sub-menu")
  );
  if (!el) return { error: "找不到父项" };
  const pop = el.parentElement.querySelector(".finder-ui-desktop-menu__popup_menu");
  if (!pop) return { error: "该父项没有 popup" };
  const st = getComputedStyle(pop);
  const pr = pop.getBoundingClientRect();
  const kids = [...pop.querySelectorAll(".finder-ui-desktop-sub-menu__item")].map((k) => {
    const r = k.getBoundingClientRect();
    const ks = getComputedStyle(k);
    return {
      text: (k.textContent || "").trim(),
      innerText: (k.innerText || "").trim(),
      w: Math.round(r.width), h: Math.round(r.height),
      display: ks.display, visibility: ks.visibility, opacity: ks.opacity,
    };
  });
  return {
    popupRect: [Math.round(pr.left), Math.round(pr.top), Math.round(pr.width), Math.round(pr.height)],
    display: st.display, visibility: st.visibility, opacity: st.opacity,
    kids,
  };
})()`;

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);
  try {
    await cdp.ensureVisible(send);
    const before = await cdp.evaluate(send, POPUP);
    console.log("悬停前：");
    console.log(JSON.stringify(before, null, 2));

    const pos = await cdp.evaluate(send, FIND_PARENT);
    if (!pos) throw new Error(`找不到父菜单「${PARENT}」`);
    console.log(`\n父项：innerText=「${pos.innerText}」 textContent=「${pos.textContent}」 rect=${pos.rect.join(",")}`);
    await cdp.hoverAt(send, pos.x, pos.y);
    await cdp.sleep(600);

    const after = await cdp.evaluate(send, POPUP);
    console.log("\n悬停后：");
    console.log(JSON.stringify(after, null, 2));
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
