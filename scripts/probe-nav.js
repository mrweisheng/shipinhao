#!/usr/bin/env node
/**
 * probe-nav.js — 验证 lib/nav.js 在「侧边栏无文字、只有图标」的当前版本下可用
 *
 * 步骤：
 *   1. 枚举顶层图标（模拟悬停，读弹窗标题）
 *   2. 从后台别的页面出发，用 clickMenuPath("互动管理","评论") 回到评论页
 *   3. 校验 URL 与视频列表是否就绪
 *
 * 用法：node scripts/probe-nav.js
 *      node scripts/probe-nav.js --path 内容管理:视频
 */

const cdp = require("./lib/cdp");
const nav = require("./lib/nav");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return d;
};
const PATH = getArg("path", "互动管理:评论");
const [PARENT, CHILD] = PATH.split(":");

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  if (!page) throw new Error("不在视频号后台页面，请先登录");
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);

  try {
    await cdp.ensureVisible(send);
    console.log(`当前：${await cdp.evaluate(send, "location.href")}\n`);

    const tops = await nav.topItems(send);
    console.log(`顶层图标 ${tops.length} 个：`);
    for (const it of tops) {
      console.log(`  #${it.index}  ${it.w}x${it.h} @(${it.x},${it.y})  内联文字=「${it.inlineText}」`);
    }

    console.log("\n逐个悬停，读弹出菜单：");
    const menu = await nav.listMenu(send);
    for (const m of menu) {
      console.log(`  #${m.index}  ${m.title || "（无弹窗）"}  →  ${m.children.join(" / ") || "—"}`);
    }

    console.log(`\n按路径点击：${PARENT} → ${CHILD}`);
    const r = await nav.clickMenuPath(send, PARENT, CHILD, { log: (s) => console.log("  " + s) });
    await cdp.sleep(1800);

    const st = await cdp.evaluate(
      send,
      `(() => {
        const host = document.querySelector("wujie-app");
        const root = host && host.shadowRoot;
        return {
          url: location.href,
          feeds: root ? root.querySelectorAll(".comment-feed-wrap").length : -1,
          label: root && root.querySelector(".feeds-nums") ? (root.querySelector(".feeds-nums").innerText || "").trim() : null,
        };
      })()`
    );
    console.log("\n到达：", JSON.stringify(st));
    const ok = r && r.clicked && st.url.includes("/platform") && st.feeds > 0;
    console.log(ok ? "\n✓ 导航可用" : "\n✗ 导航后未就绪");
    process.exit(ok ? 0 : 1);
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
