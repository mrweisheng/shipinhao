#!/usr/bin/env node
/**
 * 04-list-videos.js — 提取「评论管理」页的视频列表（自动滚动加载全部）
 *
 * 不写死任何账号/视频信息。字段全部运行时从 DOM 读取：
 *   序号(第N条) / 标题 / 时间 / 评论数 / 未读数 / 封面
 *
 * 注意：标题可能为空（纯视频无文案），此时用「第N条 + 时间」标识，
 * 不要用标题做匹配键。
 *
 * 用法：
 *   node scripts/04-list-videos.js
 *   node scripts/04-list-videos.js --json .\data\videos.json
 */

const fs = require("fs");
const path = require("path");
const cdp = require("./lib/cdp");
const channels = require("./lib/channels");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return d;
};
const PORT = Number(getArg("port", 9222));
const OUT = getArg("json", null);

const COUNT = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  return root ? root.querySelectorAll(".comment-feed-wrap").length : -1;
})()`;

// 滚动加载全部视频的逻辑在 lib/channels.js（与 05-open-video.js 共用）

const EXTRACT = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return { error: "wujie shadow root 不存在，页面可能还没加载完" };

  const pick = (el, sel) => {
    const n = el.querySelector(sel);
    return n ? (n.innerText || "").replace(/\\s+/g, " ").trim() : null;
  };

  const items = [...root.querySelectorAll(".comment-feed-wrap")];
  const feeds = items.map((el, i) => {
    const r = el.getBoundingClientRect();
    const img = el.querySelector("img.feed-img");
    return {
      index: i,
      nth: i + 1,                       // 给用户看的「第几条」，从 1 开始
      title: pick(el, ".feed-title") || null,
      time: pick(el, ".feed-time") || null,
      commentCount: pick(el, ".feed-comment-total") || null,
      unread: pick(el, ".unread-comment-number") || null,
      cover: img ? img.src : null,
      active: el.classList.contains("active-feed"),
      rect: {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
    };
  });

  const nums = root.querySelector(".feeds-nums");
  return {
    url: location.href,
    totalLabel: nums ? (nums.innerText || "").trim() : null,
    count: feeds.length,
    // 列表顺序 = 页面显示顺序（视频号助手默认按发布时间倒序）
    orderNote: "序号按页面从上到下，第1条为列表最上方",
    feeds,
  };
})()`;

(async () => {
  const pages = await cdp.listPages(PORT);
  const page = pages.find((p) => p.type === "page" && p.url.includes("interaction/comment"));
  if (!page) throw new Error("当前不在评论管理页，请先运行 scripts/03-open-comments.js");

  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);
  try {
    // 等子应用渲染出列表（刚进页面时 wujie 还在挂载）
    let ready = 0;
    for (let i = 0; i < 60; i++) {
      ready = await cdp.evaluate(send, COUNT);
      if (ready > 0) break;
      await cdp.sleep(300);
    }
    if (ready <= 0) throw new Error("等待 18s 仍未渲染出视频列表");

    // ★ 必须先确保页面可见：visibilityState=hidden 时懒加载不触发
    if (!(await cdp.ensureVisible(send))) {
      throw new Error("页面处于不可见状态（窗口被最小化），懒加载无法触发。请恢复窗口后重试");
    }

    // ★ 确保在「视频」tab（「图文」是另一批内容，序号会完全对不上）
    const tab = await channels.ensureVideoTab(send);
    if (tab && tab.found && tab.current !== "视频") {
      throw new Error(`左侧列表当前在「${tab.current || "未知"}」tab，切换到「视频」失败`);
    }

    // 滚动加载全部视频（与 05 共用；卡住会自动重载重试）
    await channels.ensureListedWithRecovery(send, null);
    await cdp.sleep(1200);              // 收尾：等最后一轮请求落地

    const data = await cdp.evaluate(send, EXTRACT);
    if (data.error) throw new Error(data.error);

    console.log(`页面：${data.url}`);
    console.log(`${data.totalLabel || "?"}，已加载 ${data.count} 条`);
    console.log(`${data.orderNote}\n`);

    for (const f of data.feeds) {
      const title = f.title ? f.title : "（无标题）";
      const unread = f.unread ? `  未读 ${f.unread}` : "";
      console.log(`第${f.nth}条  ${f.time}  评论 ${f.commentCount}${unread}`);
      console.log(`      ${title}`);
    }

    if (OUT) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(data, null, 2), "utf8");
      console.log(`\n已保存：${OUT}`);
    }
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
