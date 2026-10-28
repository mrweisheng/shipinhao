#!/usr/bin/env node
/**
 * 03-open-comments.js — 进入「互动管理 → 评论」页面
 *
 * 设计原则：
 *   - 任务开始前先检查登录状态；未登录就提示扫码，不强行点菜单
 *   - 不写死账号信息，定位靠「弹窗文字 + 结构」
 *   - 当前版本侧边栏只有图标、没有文字：nav.js 会悬停图标读弹窗标题来识别
 *   - 已在评论管理页时直接跳过，不重复导航
 *   - 进页顺序：URL 直达优先 → 菜单兜底（lib/ui.js）；走通的路由与真实路径
 *     会写回 data/ui-map.json，页面改版后下次自动用新的
 *
 * 用法：
 *   node scripts/03-open-comments.js
 *   node scripts/03-open-comments.js --wait 600          # 未登录时最多等 600s
 *   node scripts/03-open-comments.js --shot .\shots\comments.png
 */

const path = require("path");
const fs = require("fs");
const cdp = require("./lib/cdp");
const ui = require("./lib/ui");
const login = require("./lib/login");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return d;
};

const PORT = Number(getArg("port", 9222));
const SHOT = getArg("shot", null);
const WAIT = Number(getArg("wait", 300));

const t0 = Date.now();
const log = (msg) => {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
  console.log(`[+${s}s] ${msg}`);
};

const SNAPSHOT = `(() => {
  const app = document.querySelector("wujie-app");
  const root = app && app.shadowRoot;
  const txt = (root ? root.textContent : document.body.innerText) || "";
  return {
    url: location.href,
    title: document.title,
    hasWujie: !!root,
    textLen: txt.length,
    feeds: root ? root.querySelectorAll(".comment-feed-wrap").length : -1,
    total: root && root.querySelector(".feeds-nums") ? (root.querySelector(".feeds-nums").innerText || "").trim() : null,
  };
})()`;

(async () => {
  // ① 登录检查（纯 HTTP，不挂 CDP）
  const auth = await login.requireLogin({ port: PORT, wait: WAIT, log });
  if (!auth.ok) {
    console.error(
      auth.code === 3
        ? "✗ 浏览器未就绪：请先运行 node scripts\\01-launch-chrome.js 并扫码登录"
        : "✗ 等待登录超时：请扫码登录后重新运行"
    );
    process.exit(auth.code);
  }

  // ② 找到后台标签页
  const pages = await cdp.listPages(PORT);
  const page =
    pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform")) ||
    pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com"));
  if (!page) throw new Error("没找到视频号标签页，请先运行 node scripts\\01-launch-chrome.js");
  log(`目标页面：${page.url}`);

  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);

  try {
    // 页面不可见时后续的滚动懒加载（04/05）会挂起
    if (!(await cdp.ensureVisible(send))) {
      log("⚠ 页面处于不可见状态，后续列表懒加载可能不生效");
    }

    // ③ 进评论页：URL 直达优先，菜单兜底；走通的路由自动写回 data/ui-map.json
    const before = await cdp.evaluate(send, "location.href");
    if (!ui.isCommentUrl(before)) log(`当前 URL：${before}`);
    const entered = await ui.ensureCommentPageOnPage(send, { log });
    if (!entered.ok) {
      throw new Error(
        `进不去评论管理页（当前 ${entered.url || "?"}）。` +
          "可跑 scripts/probe-nav.js 看菜单是否改版，再把新路径写回 data/ui-map.json"
      );
    }
    log(
      entered.via === "already"
        ? "已在评论管理页，跳过导航"
        : `已进入评论页（${entered.via === "url" ? "URL 直达" : "菜单导航"}）：${entered.url}`
    );

    // ④ 结果快照（读 DOM，不靠截图）
    const acc = await ui.resolveAccountOnPage(send).catch(() => null);
    if (acc && acc.name) log(`当前账号：${acc.name}`);

    // 刚跳过来时列表还没渲染完：等它出现，别让后续脚本读到空列表
    let result = await cdp.evaluate(send, SNAPSHOT);
    for (let i = 0; i < 50 && result.feeds <= 0; i++) {
      await cdp.sleep(300);
      result = await cdp.evaluate(send, SNAPSHOT);
    }
    log(`内容区文本长度：${result.textLen}  列表：${result.feeds} 条${result.total ? `（${result.total}）` : ""}`);
    console.log("\n" + JSON.stringify(result, null, 2));

    if (SHOT) {
      const s = await send("Page.captureScreenshot", { format: "png" });
      fs.mkdirSync(path.dirname(SHOT), { recursive: true });
      fs.writeFileSync(SHOT, Buffer.from(s.data, "base64"));
      log(`截图已存：${SHOT}`);
    }
  } finally {
    close();
  }
})().catch((e) => {
  console.error("\n[失败] " + e.message);
  process.exit(1);
});
