#!/usr/bin/env node
/**
 * 05-open-video.js — 点开「第 N 条」视频并加载其评论
 *
 * 「第几条」= 页面视频列表从上到下的顺序（第1条 = 最上面那条）。
 * 点击前会先打印这一条的实际信息（时间/标题/评论数），便于核对意图。
 *
 * 不依赖前置步骤：
 *   - 列表没加载到第 N 条时，会自己滚动加载（每批约 10 条）
 *   - 若账号上次停在「图文」tab，会自己切回「视频」
 *   - 点完用详情区头部的「标题+时间」核对，确认点开的正是目标视频
 *
 * 用法：
 *   node scripts/05-open-video.js --nth 1
 *   node scripts/05-open-video.js --nth 3 --json .\data\video-3.json
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

// --nth 是 1 基；--index 是 0 基（兼容旧用法）；--title 按标题关键词匹配
const NTH = getArg("nth", null);
const TITLE_KW = getArg("title", null);
const INDEX = TITLE_KW !== null ? null : NTH !== null ? Number(NTH) - 1 : Number(getArg("index", 0));

// 按标题关键词解析出序号；多个命中时列出来让用户确认，不猜
const RESOLVE_BY_TITLE = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return { total: 0, hits: [], error: "页面未就绪" };
  const kw = ${JSON.stringify(TITLE_KW || "")}.replace(/\\s+/g, "").toLowerCase();
  const all = [...root.querySelectorAll(".comment-feed-wrap")];
  const rows = all.map((el, i) => {
    const t = el.querySelector(".feed-title");
    const tm = el.querySelector(".feed-time");
    return {
      index: i,
      nth: i + 1,
      title: t ? (t.innerText || "").replace(/\\s+/g, " ").trim() : "",
      time: tm ? (tm.innerText || "").trim() : null,
    };
  });
  const hits = rows.filter((r) => r.title.replace(/\\s+/g, "").toLowerCase().includes(kw));
  return { total: rows.length, hits };
})()`;

const INFO = (idx) => `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return { error: "页面未就绪" };
  const all = [...root.querySelectorAll(".comment-feed-wrap")];
  const el = all[${idx}];
  if (!el) return { error: "列表里没有第 " + (${idx} + 1) + " 条，共 " + all.length + " 条" };
  const txt = (s) => { const n = el.querySelector(s); return n ? (n.innerText || "").trim() : null; };
  const nums = root.querySelector(".feeds-nums");
  const m = nums ? (nums.innerText || "").match(/(\\d+)/) : null;
  return {
    loaded: all.length,
    declared: m ? Number(m[1]) : null,   // 页面声明的总数（共169个）
    nth: ${idx} + 1,
    title: txt(".feed-title"),
    time: txt(".feed-time"),
    commentCount: txt(".feed-comment-total"),
  };
})()`;

const RECT = (idx) => `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return null;
  const el = [...root.querySelectorAll(".comment-feed-wrap")][${idx}];
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "nearest" });
  const r = el.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  // ★ 内容在 shadowRoot 里，document.elementFromPoint 只会返回宿主 <wujie-app>，
  //   必须用 shadowRoot.elementFromPoint 才能命中内部元素。
  const hit =
    (typeof root.elementFromPoint === "function" ? root.elementFromPoint(x, y) : null) ||
    document.elementFromPoint(x, y);
  return {
    x, y,
    hitInside: !!(hit && el.contains(hit)),
    hitTag: hit ? hit.tagName.toLowerCase() : null,
    hitCls: hit ? String(hit.className || "").slice(0, 40) : null,
    inViewport: r.top >= 0 && r.bottom <= innerHeight,
  };
})()`;

// 评论区顶部（详情区）的「当前视频」信息。
// ★ 关键：这条信息可以用来确定「点开的到底是哪条视频」。
//   结构：.feed-detail > .feed-basic-info > .feed-selected-info > .feed-title / .feed-time
//   注意它与列表项用的是同一个类名 .feed-title，所以取列表时必须限定在 .comment-feed-wrap 内。
const DETAIL_META = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return null;
  const box = root.querySelector(".feed-selected-info");
  const tips = root.querySelector(".comment-count__tips");
  const items = root.querySelectorAll(".comment-item").length;
  const t = box && box.querySelector(".feed-title");
  const tm = box && box.querySelector(".feed-time");

  // ★ 0 评论的页面不会渲染 .comment-count__tips，只在 .feed-comment__wrp 里显示「暂无评论」。
  //   所以不能用「tips 存在」判断评论区是否挂载。
  const wrp = root.querySelector(".feed-comment__wrp");
  const wrpText = wrp ? (wrp.innerText || "").replace(/\\s+/g, " ").trim() : "";
  const emptyHint =
    items === 0 && /暂无评论|还没有评论|暂无数据/.test(wrpText) ? wrpText.slice(0, 40) : null;

  return {
    hasHeader: !!box,
    title: t ? (t.innerText || "").replace(/\\s+/g, " ").trim() : null,
    time: tm ? (tm.innerText || "").replace(/\\s+/g, " ").trim() : null,
    mounted: !!tips || !!emptyHint,
    items,
    tips: tips ? (tips.innerText || "").trim() : null,
    emptyHint,
  };
})()`;

// 把两种时间格式归一化：
//   列表：2026/10/17 07:05      详情：2026年10月17日 07:05
const normTime = (s) => {
  if (!s) return null;
  const m = String(s).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{1,2}):(\d{2})/);
  if (!m) return String(s).replace(/\s+/g, "");
  return `${m[1]}/${String(m[2]).padStart(2, "0")}/${String(m[3]).padStart(2, "0")} ` +
         `${String(m[4]).padStart(2, "0")}:${m[5]}`;
};

const normTitle = (s) => (s ? String(s).replace(/\s+/g, "") : "");

// 列表滚动加载、tab 切换等站点级动作放在 lib/channels.js（04 与 05 共用）

/**
 * 把视频列表滚到至少 want 条（want = null 表示滚到全部）。
 * 实现在 lib/channels.js，与 04-list-videos.js 共用。
 */
const ensureListed = (send, want) => channels.ensureListedWithRecovery(send, want);

(async () => {
  const pages = await cdp.listPages(PORT);
  const page = pages.find((p) => p.type === "page" && p.url.includes("interaction/comment"));
  if (!page) throw new Error("当前不在评论管理页");

  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);
  try {
    // ★ 页面不可见时点击与懒加载都可能失效，先确保可见
    if (!(await cdp.ensureVisible(send))) {
      throw new Error("页面不可见（窗口被最小化），请恢复窗口后重试");
    }

    // ★ 确保左侧列表在「视频」tab（账号可能上次停在「图文」，那样列表是另一批内容）
    const tab = await channels.ensureVideoTab(send);
    if (tab && tab.found && tab.current !== "视频") {
      throw new Error(`左侧列表当前在「${tab.current || "未知"}」tab，切换到「视频」失败`);
    }

    // 确定要打开哪一条
    let idx = INDEX;
    if (TITLE_KW !== null) {
      // 按标题找必须先把列表全部加载出来，否则会漏掉还没渲染的记录
      await ensureListed(send, null);
      const r = await cdp.evaluate(send, RESOLVE_BY_TITLE);
      if (!r.hits.length) {
        const all = r.total ? `共 ${r.total} 条，均不含该关键词` : "列表为空";
        throw new Error(`没有标题包含「${TITLE_KW}」的视频（${all}）`);
      }
      if (r.hits.length > 1) {
        console.log(`「${TITLE_KW}」命中 ${r.hits.length} 条，请指定更精确的关键词或改用 --nth：\n`);
        for (const h of r.hits) {
          console.log(`  第${h.nth}条  ${h.time}  ${h.title}`);
        }
        process.exit(2);
      }
      idx = r.hits[0].index;
    } else {
      if (!Number.isInteger(idx) || idx < 0) throw new Error("--nth 需要是从 1 开始的整数");
      await ensureListed(send, idx + 1);
    }

    const info = await cdp.evaluate(send, INFO(idx));
    if (info.error) throw new Error(info.error);

    console.log(`点开第 ${info.nth} 条（共 ${info.declared ?? info.loaded} 条，已渲染 ${info.loaded}）：`);
    console.log(`  标题：${info.title || "（无标题）"}`);
    console.log(`  时间：${info.time}`);
    console.log(`  评论数：${info.commentCount}`);

    const pos = await cdp.evaluate(send, RECT(idx));
    if (!pos) throw new Error("取坐标失败，元素可能已被移出列表");
    if (!pos.hitInside) {
      throw new Error(
        `点击坐标 (${pos.x},${pos.y}) 命中 <${pos.hitTag}> 而不是目标视频（可能被浮层遮挡或列表被重排），已中止`
      );
    }
    if (!pos.inViewport) {
      console.log("⚠ 目标项未完全在视口内（屏幕较小时可能出现），仍尝试点击");
    }

    await cdp.clickAt(send, pos.x, pos.y);

    // ── 确认点开的正是目标视频 ──────────────────────────
    // 判据：详情区头部的「标题 + 时间」与目标一致（时间格式先归一化）。
    // 只等「出现评论」是不够的：新视频加载时，旧视频的评论还挂在 DOM 上。
    const wantTitle = normTitle(info.title);
    const wantTime = normTime(info.time);

    let st = null;
    let matched = false;
    for (let i = 0; i < 120; i++) {
      await cdp.sleep(150);
      st = await cdp.evaluate(send, DETAIL_META);
      if (!st || !st.hasHeader) continue;
      const sameTime = normTime(st.time) === wantTime;
      const sameTitle = normTitle(st.title) === wantTitle;
      if (sameTime && sameTitle) { matched = true; break; }
    }

    if (!matched) {
      throw new Error(
        "点击后详情区头部未切换到目标视频。期望：" +
          `${info.time} / ${(info.title || "").slice(0, 30)}\n` +
          `实际：${st ? `${st.time} / ${(st.title || "").slice(0, 30)}` : "读不到详情头部"}`
      );
    }

    // 头部已确认，再等评论区挂载完成（tips 出现；有评论则等首条渲染）
    for (let i = 0; i < 80; i++) {
      st = await cdp.evaluate(send, DETAIL_META);
      if (st && st.mounted && (st.items > 0 || st.emptyHint)) break;
      await cdp.sleep(150);
    }

    if (!st || !st.mounted || (st.items === 0 && !st.emptyHint)) {
      throw new Error(`详情区已切换到目标视频，但评论未渲染（条数 ${st ? st.items : "?"}）`);
    }

    console.log(`\n✓ 已确认打开：${normTime(st.time)}`);
    console.log(`  评论区就绪：${st.items} 条（${st.tips || "无提示"}）` + (st.emptyHint ? `（${st.emptyHint}）` : ""));

    if (OUT) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify({ ...info, pos }, null, 2), "utf8");
      console.log(`已保存：${OUT}`);
    }
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
