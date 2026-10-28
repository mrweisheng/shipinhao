#!/usr/bin/env node
/**
 * probe-comment-count-gap.js — 页面声明 N 条，DOM 只有 N-2 条，差在哪？
 *
 * 打开第 --nth 条视频，滚到底，收集所有 comment_list 返回体，统计：
 *   - 顶层评论数 / 二级回复数 / 合计
 *   - 去重后的 commentId 数（分页重复？）
 *   - downContinueFlag=1 的线程（还有回复没下发）
 *   - visibleFlag / displayFlag 分布（被过滤的评论）
 *
 * 用法：node scripts/probe-comment-count-gap.js --nth 28 [--keep]
 */

const fs = require("fs");
const path = require("path");
const cdp = require("./lib/cdp");
const channels = require("./lib/channels");

const argv = process.argv.slice(2);
const getArg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const NTH = Number(getArg("nth", "28"));

const STATE = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return null;
  const tips = root.querySelector(".comment-count__tips");
  const wrp = root.querySelector(".feed-comment__wrp");
  let sc = wrp;
  while (sc && sc !== root && !(sc.scrollHeight > sc.clientHeight + 20)) sc = sc.parentElement;
  return {
    items: root.querySelectorAll(".comment-item").length,
    tip: tips ? (tips.innerText || "").trim() : null,
    loadMore: root.querySelectorAll(".load-more").length,
    spinner: root.querySelectorAll(".load-more img").length,
    bottom: sc && sc !== root ? Math.round(sc.scrollTop + sc.clientHeight) >= Math.round(sc.scrollHeight) - 5 : null,
  };
})()`;

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  const { send, on, close } = await cdp.attach(page.webSocketDebuggerUrl);

  const reqs = new Map();
  const bodies = [];
  try {
    await send("Network.enable", {});
    on("Network.requestWillBeSent", (p) => {
      if (/comment\/comment_list/.test(p.request.url)) {
        reqs.set(p.requestId, { url: p.request.url, postData: p.request.postData });
      }
    });
    on("Network.loadingFinished", async (p) => {
      const r = reqs.get(p.requestId);
      if (!r) return;
      try {
        const b = await send("Network.getResponseBody", { requestId: p.requestId });
        bodies.push({ ...r, body: b.body, b64: b.base64Encoded });
      } catch (e) {
        bodies.push({ ...r, error: e.message });
      }
    });

    await cdp.ensureVisible(send);
    await channels.ensureVideoTab(send);
    await channels.ensureListedWithRecovery(send, NTH, { log: (s) => console.log("  " + s) });

    const rect = await cdp.evaluate(send, `(() => {
      const host = document.querySelector("wujie-app");
      const root = host && host.shadowRoot;
      const el = [...root.querySelectorAll(".comment-feed-wrap")][${NTH - 1}];
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    await cdp.sleep(500);
    await cdp.clickAt(send, rect.x, rect.y);

    // 滚到底，直到条数 20s 不动
    let last = -1;
    let lastGrowth = Date.now();
    for (let i = 0; i < 400; i++) {
      const st = await cdp.evaluate(send, STATE);
      if (!st) break;
      if (st.items !== last) {
        if (i % 5 === 0 || i < 3) console.log(`  t+${i}s  ${st.items} 条 ${st.tip || ""}`);
        last = st.items;
        lastGrowth = Date.now();
      }
      const declared = st.tip ? Number((st.tip.match(/(\d+)/) || [])[1]) : null;
      const done = declared !== null && st.items >= declared;
      if (done) { console.log(`  达到声明数：${st.items}/${declared}`); break; }
      if (Date.now() - lastGrowth > 20000) {
        console.log(`  20s 无新增，停在 ${st.items}（声明 ${declared}），load-more=${st.loadMore} spinner=${st.spinner}`);
        break;
      }
      await cdp.evaluate(send, `(() => {
        const host = document.querySelector("wujie-app");
        const root = host && host.shadowRoot;
        const wrp = root && root.querySelector(".feed-comment__wrp");
        if (!wrp) return false;
        let sc = wrp;
        while (sc && sc !== root && !(sc.scrollHeight > sc.clientHeight + 20)) sc = sc.parentElement;
        if (!sc || sc === root) return false;
        sc.scrollTop = sc.scrollHeight;
        return true;
      })()`).catch(() => {});
      await cdp.sleep(700);
    }

    await cdp.sleep(2000);
    const fin = await cdp.evaluate(send, STATE);
    console.log(`\n最终 DOM：${JSON.stringify(fin)}`);
    console.log(`comment_list 请求：${bodies.length} 次`);

    // 汇总
    const seen = new Set();
    let top = 0;
    let l2 = 0;
    let dup = 0;
    let declaredApi = null;
    const flags = {};
    const contThreads = [];
    for (const b of bodies) {
      if (b.error) continue;
      let txt = b.body;
      if (b.b64) txt = Buffer.from(txt, "base64").toString("utf8");
      let j;
      try { j = JSON.parse(txt); } catch { continue; }
      const d = j.data || {};
      if (declaredApi === null && typeof d.commentCount === "number") declaredApi = d.commentCount;
      for (const c of d.comment || []) {
        top++;
        if (c.commentId) {
          if (seen.has(c.commentId)) dup++;
          else seen.add(c.commentId);
        }
        const key = `v${c.visibleFlag}/d${c.displayFlag}`;
        flags[key] = (flags[key] || 0) + 1;
        if (c.downContinueFlag === 1) contThreads.push({ user: c.commentNickname, txt: (c.commentContent || "").slice(0, 30), kids: (c.levelTwoComment || []).length });
        for (const k of c.levelTwoComment || []) {
          l2++;
          if (k.commentId) {
            if (seen.has(k.commentId)) dup++;
            else seen.add(k.commentId);
          }
          const kk = `l2-v${k.visibleFlag}/d${k.displayFlag}`;
          flags[kk] = (flags[kk] || 0) + 1;
        }
      }
    }
    console.log(`\n接口侧：声明 ${declaredApi}，顶层 ${top}，二级 ${l2}，合计 ${top + l2}，去重后 ${seen.size}，重复 ${dup}`);
    console.log("标志位分布：", JSON.stringify(flags, null, 2));
    console.log(`仍有未下发回复的线程（downContinueFlag=1）：${contThreads.length}`);
    for (const t of contThreads.slice(0, 10)) console.log(`  ${t.user}「${t.txt}」已下发 ${t.kids} 条`);

    const dir = path.join(__dirname, "..", "data", "probe");
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `count-gap-nth${NTH}.json`);
    fs.writeFileSync(out, JSON.stringify({ declaredApi, top, l2, dup, unique: seen.size, flags, contThreads, dom: fin }, null, 2), "utf8");
    console.log(`已保存：${out}`);
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
