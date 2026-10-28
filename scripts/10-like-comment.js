#!/usr/bin/env node
/**
 * 10-like-comment.js — 给「已回复」的一级评论点赞（红赞 = 已回复标记）
 *
 * 纪律：只对已回复的评论点赞；跳过类永不点赞。
 * 已赞判定：`.like-action svg` 带 `fill-like` 且 `use[href="#icon-fill-thumb"]`。
 *
 * 用法：
 *   node scripts/10-like-comment.js --name 健文 --kw 订购一台白色
 *   node scripts/10-like-comment.js --name cool星 --kw 多2萬蚊 --dry
 */

const cdp = require("./lib/cdp");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return d;
};

const PORT = Number(getArg("port", 9222));
const NAME = getArg("name", null);
const KW = getArg("kw", null);
const DRY = argv.includes("--dry");

if (!NAME || !KW) {
  console.error("需要 --name 昵称片段 --kw 内容关键词");
  process.exit(1);
}

const LOCATE = (name, kw) => `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return { error: "wujie shadow root 不存在" };
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const items = [...root.querySelectorAll(".comment-item")].filter((el) => !el.closest(".comment-reply-list"));
  const hits = items.filter((el) => {
    const n = el.querySelector(".comment-user-name");
    const c = el.querySelector(".comment-content");
    return n && norm(n.innerText).includes(${JSON.stringify(name)})
        && c && norm(c.innerText).includes(${JSON.stringify(kw)});
  });
  if (hits.length !== 1) return { found: hits.length };
  const el = hits[0];
  el.scrollIntoView({ block: "center" });
  const la = el.querySelector(".like-action");
  if (!la) return { found: 1, error: "NO_LIKE" };
  const svg = la.querySelector("svg");
  const use = svg && svg.querySelector("use");
  const r = la.getBoundingClientRect();
  return {
    found: 1,
    liked: !!(svg && svg.classList.contains("fill-like")),
    href: use ? (use.getAttribute("xlink:href") || use.getAttribute("href")) : null,
    count: (la.querySelector(".action-count") || {}).innerText || null,
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    item: {
      name: norm(el.querySelector(".comment-user-name")?.innerText || ""),
      time: norm(el.querySelector(".comment-time")?.innerText || ""),
      text: norm(el.querySelector(".comment-content")?.innerText || "").slice(0, 40),
      replies: el.querySelectorAll(".comment-reply-list .comment-item").length,
    },
  };
})()`;

(async () => {
  const pages = await cdp.listPages(PORT);
  const page = pages.find((p) => p.type === "page" && p.url.includes("interaction/comment"));
  if (!page) throw new Error("当前不在评论管理页");

  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);
  try {
    if (!(await cdp.ensureVisible(send))) throw new Error("页面不可见");
    await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});

    let hit = await cdp.evaluate(send, LOCATE(NAME, KW));
    if (!hit || hit.found !== 1) {
      await cdp.evaluate(send, `(() => {
        const box = document.querySelector("wujie-app").shadowRoot.querySelector(".feed-comment__wrp");
        if (box) box.scrollTop = 0;
      })()`);
      await cdp.sleep(500);
      for (let i = 0; i < 30; i++) {
        hit = await cdp.evaluate(send, LOCATE(NAME, KW));
        if (hit && hit.found === 1) break;
        const moved = await cdp.evaluate(send, `(() => {
          const box = document.querySelector("wujie-app").shadowRoot.querySelector(".feed-comment__wrp");
          if (!box) return null;
          const b = box.scrollTop;
          box.scrollTop = b + Math.round(box.clientHeight * 0.9);
          return { b, a: Math.round(box.scrollTop) };
        })()`);
        await cdp.sleep(450);
        if (!moved || moved.b === moved.a) break;
      }
    }
    if (!hit || hit.found !== 1) throw new Error(`目标未唯一命中（${hit && hit.found}）`);
    if (hit.item.replies === 0) {
      console.error("[拦截] 该评论没有回复，按纪律不点赞");
      process.exitCode = 4;
      return;
    }
    console.log(`① 命中：${hit.item.name}｜${hit.item.time}｜回复 ${hit.item.replies} 条｜like=${hit.href}｜count=${hit.count}`);

    if (hit.liked) {
      console.log("② 已经是红赞，跳过");
      return;
    }
    if (DRY) {
      console.log(`② dry：未点赞，位置 (${hit.x},${hit.y})`);
      return;
    }

    await cdp.sleep(300);
    hit = await cdp.evaluate(send, LOCATE(NAME, KW));
    await cdp.clickAt(send, hit.x, hit.y);

    let after = null;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await cdp.sleep(400);
      after = await cdp.evaluate(send, LOCATE(NAME, KW));
      if (after && after.liked) break;
    }
    console.log(`③ 点赞后：liked=${after && after.liked}｜href=${after && after.href}｜count=${after && after.count}`);
    if (!after || !after.liked) throw new Error("点赞未生效");
    console.log("✓ 已点赞（红赞）");
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + (e.message || e));
  process.exitCode = 1;
});
