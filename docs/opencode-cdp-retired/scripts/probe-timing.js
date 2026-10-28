#!/usr/bin/env node
/**
 * probe-timing.js — 复现「刚点菜单跳到别的页，立刻再点另一个菜单」的时序问题
 *
 * 步骤：
 *   1. 确保在评论页
 *   2. 点「内容管理 → 图文」离开
 *   3. 立刻点「互动管理 → 评论」
 *   4. 每 500ms 打印一次各顶层图标的弹窗状态，直到成功或超时
 */

const cdp = require("./lib/cdp");
const nav = require("./lib/nav");

const waitComment = async (send) => {
  for (let i = 0; i < 40; i++) {
    const u = await cdp.evaluate(send, "location.href").catch(() => "");
    if (u.includes("/interaction/comment")) return true;
    await cdp.sleep(300);
  }
  return false;
};

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);

  try {
    // 1. 先回评论页
    if (!(await waitComment(send))) {
      await nav.clickMenuPath(send, "互动管理", "评论");
      await waitComment(send);
    }
    console.log("起点：", await cdp.evaluate(send, "location.href"));

    // 2. 点去图文
    await nav.clickMenuPath(send, "内容管理", "图文");
    await cdp.sleep(600);
    console.log("已离开：", await cdp.evaluate(send, "location.href"));

    // 3. 立刻点回评论
    const t0 = Date.now();
    try {
      await nav.clickMenuPath(send, "互动管理", "评论");
      console.log(`✓ 点回成功，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      console.log(`✗ 点回失败：${e.message}（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    }

    // 4. 打印当前各图标弹窗状态
    const items = await nav.topItems(send);
    for (const it of items) {
      const info = await nav.menuPathInfo(send, it.index);
      console.log(`  #${it.index} 内联=「${it.inlineText}」  标题=${info ? `「${info.title}」` : "null"}  visible=${info ? info.visible : "-"}`);
    }

    await cdp.sleep(1200);
    console.log("最终 URL：", await cdp.evaluate(send, "location.href"));
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
