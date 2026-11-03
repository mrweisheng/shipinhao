#!/usr/bin/env node
/**
 * probe-reply-visibility.js — 对比「自己看得到、别人看不到」的回复在接口里的字段差异
 *
 * 背景：2026-10-24 健文那条回复在作者视角可见，但换号看被吞。
 * 猜测：接口 comment 对象里 displayFlag / visibleFlag / blacklistFlag 能区分「仅作者可见」。
 *
 * 做法：重载页面 → 打开第 N 条视频 → 抓 comment_list 返回体 →
 *       把所有作者回复的 displayFlag 分布打出来，并逐条列出指定关键词的回复。
 *
 * 用法：node scripts/probe-reply-visibility.js --nth 1
 */

const fs = require("fs");
const path = require("path");
const cdp = require("./lib/cdp");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return d;
};
const NTH = Number(getArg("nth", 1));
const OUT = getArg("json", path.join(__dirname, "..", "data", "probe", "reply-visibility.json"));

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  if (!page) throw new Error("没找到视频号后台标签页");

  const { send, on, close } = await cdp.attach(page.webSocketDebuggerUrl);
  const bodies = [];
  const pending = new Map();
  try {
    await send("Network.enable", {});
    on("Network.requestWillBeSent", (p) => {
      if (/comment\/comment_list/.test(p.request.url)) pending.set(p.requestId, p.request.url);
    });
    on("Network.loadingFinished", async (p) => {
      if (!pending.has(p.requestId)) return;
      pending.delete(p.requestId);
      try {
        const b = await send("Network.getResponseBody", { requestId: p.requestId });
        bodies.push(b.base64Encoded ? Buffer.from(b.body, "base64").toString("utf8") : b.body);
      } catch (e) { /* 忽略单次失败 */ }
    });

    await cdp.ensureVisible(send);
    await cdp.evaluate(send, "location.reload()");
    await cdp.sleep(1500);
    await cdp.waitFor(send, `(() => {
      const root = document.querySelector("wujie-app")?.shadowRoot;
      return !!(root && root.querySelectorAll(".comment-feed-wrap").length);
    })()`, { timeout: 30000 });

    // 点第 N 张卡片
    const pos = await cdp.evaluate(send, `(() => {
      const root = document.querySelector("wujie-app").shadowRoot;
      const el = [...root.querySelectorAll(".comment-feed-wrap")][${NTH - 1}];
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!pos) throw new Error("卡片不存在");
    await cdp.sleep(300);
    await cdp.clickAt(send, pos.x, pos.y);

    // 等评论渲染 + 多抓几页
    await cdp.waitFor(send, `(() => {
      const root = document.querySelector("wujie-app")?.shadowRoot;
      return !!(root && root.querySelectorAll(".comment-item").length);
    })()`, { timeout: 20000 });

    for (let i = 0; i < 6; i++) {
      await cdp.sleep(700);
      await cdp.evaluate(send, `(() => {
        const root = document.querySelector("wujie-app").shadowRoot;
        const box = root.querySelector(".feed-comment__wrp");
        if (box) box.scrollTop = box.scrollHeight;
        return !!box;
      })()`);
    }
    await cdp.sleep(1200);

    const rows = [];
    for (const raw of bodies) {
      let j;
      try { j = JSON.parse(raw); } catch { continue; }
      for (const c of (j.data && j.data.comment) || []) {
        const push = (x, lvl, parent) => rows.push({
          lvl, parent,
          name: x.commentNickname, content: x.commentContent,
          ts: x.commentCreatetime,
          time: x.commentCreatetime ? new Date(Number(x.commentCreatetime) * 1000).toLocaleString("zh-CN", { hour12: false }) : null,
          id: x.commentId, displayFlag: x.displayFlag, visibleFlag: x.visibleFlag,
          blacklistFlag: x.blacklistFlag, likeFlag: x.likeFlag, likeCount: x.commentLikeCount,
          readFlag: x.readFlag, downContinueFlag: x.downContinueFlag,
        });
        push(c, 1, null);
        for (const r of c.levelTwoComment || []) push(r, 2, c.commentId);
      }
    }
    // 去重
    const uniq = [...new Map(rows.map((r) => [r.id, r])).values()];
    const mine = uniq.filter((r) => r.name === "明哥揾粤港车" || r.name === "明哥揀粤港车" || r.name === "明哥粤港车");

    const dist = {};
    for (const r of mine) dist[r.displayFlag] = (dist[r.displayFlag] || 0) + 1;

    const now = Math.floor(Date.now() / 1000);
    const recent = mine.filter((r) => r.ts && now - Number(r.ts) < 3600);

    console.log(`抓到 ${uniq.length} 条评论（${bodies.length} 次 comment_list）`);
    console.log("作者回复 displayFlag 分布：", JSON.stringify(dist));
    console.log("\n近 1 小时的作者回复：");
    for (const r of recent) {
      console.log(`- ${r.time}｜L${r.lvl}｜${r.content}`);
      console.log(`    displayFlag=${r.displayFlag} visibleFlag=${r.visibleFlag} blacklistFlag=${r.blacklistFlag} likeFlag=${r.likeFlag} likeCount=${r.likeCount} readFlag=${r.readFlag}`);
    }

    const dir = path.dirname(OUT);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ capturedAt: new Date().toISOString(), dist, recent, mine, all: uniq }, null, 2), "utf8");
    console.log("\n完整记录：" + OUT);
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + (e.message || e));
  process.exitCode = 1;
});
