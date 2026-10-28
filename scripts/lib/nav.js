/**
 * lib/nav.js — 后台菜单导航（版本无关）
 *
 * ★ 当前版本的事实（用户确认）：
 *   左侧边栏**不显示文字**，只有图标。鼠标悬停到图标上，才弹出带文字的二级菜单。
 *   旧版本可能直接在侧边栏显示文字，所以这里两种都要支持：
 *     1) 侧边栏项本身有文字 → 直接按文字匹配
 *     2) 侧边栏项没有文字（当前版本）→ 逐个悬停，读弹出菜单的标题来认出它
 *
 * 于是「互动管理 → 评论」这种路径在任何版本下都能走通，且不依赖图标顺序、不依赖坐标常量。
 *
 * 主要接口：
 *   topItems(send)                     顶层图标列表（坐标 + 是否有内联文字）
 *   menuPathInfo(send, index)          某个图标的弹出菜单（标题 + 子项）
 *   clickMenuPath(send, parent, child) 按文字点开「父 → 子」
 *   listMenu(send)                     枚举所有「父 → 子」路径（用于测试/文档）
 */

const cdp = require("./cdp");

const norm = (s) => (s || "").replace(/\s+/g, "").trim();

/** 顶层图标（排除弹窗/二级菜单里的项；要求有实际尺寸） */
const TOP_ITEMS = `(() => {
  const links = [...document.querySelectorAll(".finder-ui-desktop-menu__link")];
  const items = [];
  for (const el of links) {
    // ★ 两个都要排除：有的页面子项外层是 .finder-ui-desktop-sub-menu，
    //   有的页面（如图文列表）子项直接挂在 .finder-ui-desktop-menu__popup_menu 里。
    //   只排除前者会把「评论/弹幕/私信」误当成顶层图标，index 全部错位。
    if (el.closest(".finder-ui-desktop-menu__popup_menu")) continue;
    if (el.closest(".finder-ui-desktop-sub-menu")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 30 || r.height < 20) continue;
    items.push({
      index: items.length,
      inlineText: (el.textContent || "").replace(/\\s+/g, "").trim(),  // 旧版内联文字，当前版本为空
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
  }
  return items;
})()`;

/** 第 index 个顶层图标的弹出菜单信息 */
const pathInfoExpr = (index) => `(() => {
  const links = [...document.querySelectorAll(".finder-ui-desktop-menu__link")];
  const tops = [];
  for (const el of links) {
    if (el.closest(".finder-ui-desktop-menu__popup_menu")) continue;
    if (el.closest(".finder-ui-desktop-sub-menu")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 30 || r.height < 20) continue;
    tops.push(el);
  }
  const el = tops[${index}];
  if (!el) return null;

  const pop = el.parentElement.querySelector(".finder-ui-desktop-menu__popup_menu");
  if (!pop) return null;

  // 弹窗标题 = 弹窗文本去掉子项列表（不同版本子项的包裹层不同，用文本对比兜底）
  const clone = pop.cloneNode(true);
  clone.querySelectorAll("ul, .finder-ui-desktop-sub-menu, .finder-ui-desktop-sub-menu__item").forEach((n) => n.remove());
  const title = (clone.textContent || "").replace(/\\s+/g, "").trim();

  const st = getComputedStyle(pop);
  const pr = pop.getBoundingClientRect();
  const kids = [...pop.querySelectorAll(".finder-ui-desktop-sub-menu__item")].map((k) => {
    const r = k.getBoundingClientRect();
    return {
      text: (k.textContent || "").replace(/\\s+/g, "").trim(),
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });

  return {
    title,
    display: st.display,
    visible: st.display !== "none" && st.visibility !== "hidden" && pr.width > 20,
    rect: [Math.round(pr.left), Math.round(pr.top), Math.round(pr.width), Math.round(pr.height)],
    kids,
  };
})()`;

async function topItems(send) {
  return (await cdp.evaluate(send, TOP_ITEMS)) || [];
}

async function menuPathInfo(send, index) {
  return cdp.evaluate(send, pathInfoExpr(index));
}

/** 悬停某个顶层图标，并等它的弹出菜单出现 */
async function hoverTop(send, item, { timeout = 2000 } = {}) {
  // 先把鼠标移开：上一次悬停的弹窗若还挂着，直接再悬停同一项可能不再触发
  await cdp.hoverAt(send, 5, 5).catch(() => {});
  await cdp.sleep(80);
  await cdp.hoverAt(send, item.x, item.y);

  const deadline = Date.now() + timeout;
  let info = null;
  while (Date.now() < deadline) {
    await cdp.sleep(150);
    info = await menuPathInfo(send, item.index);
    if (info && info.visible && info.kids.some((k) => k.w > 5)) return info;
  }
  // 弹窗已经出现，但子项还在动画/布局中：再宽限一拍
  if (info && info.visible) {
    await cdp.sleep(400);
    info = await menuPathInfo(send, item.index);
  }
  return info;
}

/**
 * 按「父菜单文字 + 子菜单文字」点击进入。
 * 父菜单文字的识别顺序：
 *   1. 侧边栏内联文字（旧版本）
 *   2. 逐个悬停图标，读弹出菜单标题（当前版本）
 */
async function clickMenuPath(send, parentText, childText, { log = () => {} } = {}) {
  const wantParent = norm(parentText);
  const wantChild = norm(childText);

  let items = await topItems(send);
  if (!items.length) {
    // 整页重载（直接改地址）后，应用外壳可能还没挂载：等它出现，别急着报错
    log("等待侧边栏挂载…");
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await cdp.sleep(400);
      items = await topItems(send);
      if (items.length) break;
    }
  }
  if (!items.length) throw new Error("侧边栏菜单没找到（页面可能未登录或结构变更）");

  // 1) 内联文字直接命中（旧版本侧边栏显示文字）
  let target = items.find((it) => norm(it.inlineText) === wantParent);
  let method = "inline-text";

  // 2) 当前版本：侧边栏只有图标，逐个悬停看弹出菜单标题
  if (!target) {
    method = "hover-probe";
    for (const it of items) {
      const info = await hoverTop(send, it, { timeout: 1200 });
      if (!info) continue;
      if (norm(info.title) === wantParent || norm(info.title).includes(wantParent)) {
        target = it;
        break;
      }
    }
  }
  if (!target) {
    const known = [];
    for (const it of items.slice(0, 12)) {
      const info = await hoverTop(send, it, { timeout: 800 });
      if (info && info.title) known.push(info.title);
    }
    throw new Error(
      `找不到父菜单「${parentText}」。当前侧边栏可识别的菜单：${known.join(" / ") || "（无）"}`
    );
  }

  // 重页面（如图文列表）主线程忙，悬停反馈可能延迟几秒：第一次给 5s，之后各给 3.5s
  let info = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    info = await hoverTop(send, target, { timeout: attempt === 0 ? 5000 : 3500 });
    if (info && info.visible && info.kids.some((k) => norm(k.text) === wantChild && k.w > 5)) break;
    await cdp.sleep(300);
  }
  if (!info || !info.visible) throw new Error(`悬停「${parentText}」后弹出菜单未出现`);
  log(`「${parentText}」弹出菜单：${info.kids.map((k) => k.text).join(" / ")}`);

  const child = info.kids.find((k) => norm(k.text) === wantChild);
  if (!child || child.w < 5 || child.h < 5) {
    throw new Error(
      `「${parentText}」下找不到可点击的「${childText}」，现有：${info.kids.map((k) => k.text).join(" / ")}`
    );
  }

  await cdp.clickAt(send, child.x, child.y);
  log(`已点击「${parentText} → ${childText}」（识别方式：${method === "inline-text" ? "侧边栏文字" : "悬停弹窗"}）`);
  return { clicked: true, method, child };
}

/** 枚举所有可点的「父 → 子」路径（悬停一遍所有图标） */
async function listMenu(send) {
  const items = await topItems(send);
  const out = [];
  for (const it of items) {
    const info = await hoverTop(send, it, { timeout: 1200 });
    if (!info) { out.push({ index: it.index, title: null, children: [] }); continue; }
    out.push({
      index: it.index,
      title: info.title,
      children: info.kids.filter((k) => k.w > 5).map((k) => k.text),
    });
  }
  // 移开鼠标，避免菜单一直挂着
  try { await cdp.hoverAt(send, 5, 5); } catch { /* 忽略 */ }
  return out;
}

/** 当前是否在评论管理页 */
async function onCommentPage(send) {
  const url = await cdp.evaluate(send, "location.href");
  return typeof url === "string" && url.includes("/platform/interaction/comment");
}

module.exports = { topItems, menuPathInfo, hoverTop, clickMenuPath, listMenu, onCommentPage };
