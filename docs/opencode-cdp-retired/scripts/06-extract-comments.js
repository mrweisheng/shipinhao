#!/usr/bin/env node
/**
 * 06-extract-comments.js — 提取当前视频的「全部」评论，并判断作者是否已回复
 *
 * 三个关键能力：
 *   1. 自动滚动加载：评论列表是懒加载的，脚本会滚到底直到条数不再增长，
 *      并与页面上的「共 N 条评论」对账，避免只抓到一屏。
 *   2. 回复关系：回复嵌套在父评论的 .comment-reply-list 里，脚本还原 parentIndex，
 *      从而对每条一级评论给出「作者是否回复过」。
 *   3. 内容完整：表情是 <img alt="[悠闲]">，innerText 会丢，这里把 img 换成 alt 文本。
 *
 * 用法：
 *   node scripts/06-extract-comments.js
 *   node scripts/06-extract-comments.js --json .\data\comments.json
 *   node scripts/06-extract-comments.js --no-scroll      # 只抓当前已加载的
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
const PORT = Number(getArg("port", 9222));
const OUT = getArg("json", null);
const NO_SCROLL = argv.includes("--no-scroll");
const UNREPLIED = argv.includes("--unreplied");

/**
 * 作者身份白名单（不写死在页面逻辑里，可用 --author 或环境变量覆盖）。
 * 页面只在「主号」回复上打「作者」badge；小号「明哥粤港车」回复不带 badge，
 * 只靠 badge 判定会把小号回复当成「观众回复」，导致误判待回、甚至重复回复。
 */
const AUTHOR_NAMES = (getArg("author", null) || process.env.AUTHOR_NAMES ||
  "明哥揀粤港车,明哥揾粤港车,明哥粤港车")
  .split(",").map((s) => s.trim()).filter(Boolean);

/** 用白名单补齐 isAuthor，并重算每条一级评论的回复状态 */
function normalizeAuthors(data) {
  if (!data || !Array.isArray(data.comments)) return data;
  for (const c of data.comments) {
    if (!c.isAuthor && AUTHOR_NAMES.includes((c.author || "").trim())) c.isAuthor = true;
  }
  for (const c of data.comments) {
    if (c.level !== 1) continue;
    const reps = data.comments.filter((r) => r.parentIndex === c.index);
    const mine = reps.filter((r) => r.isAuthor);
    c.replyCount = reps.length;
    c.authorReplyCount = mine.length;
    c.authorReplied = mine.length > 0;
    c.lastAuthorReplyAt = mine.length ? mine[mine.length - 1].time : null;
  }
  return data;
}

/** 统计当前已渲染的条数与页面声明的总数 */
const STAT = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return null;
  const tips = root.querySelector(".comment-count__tips");
  const tipText = tips ? (tips.innerText || "").trim() : "";
  const m = tipText.match(/(\\d+)\\s*条/);
  const items = root.querySelectorAll(".comment-item").length;

  // ★ 0 评论时页面不渲染 .comment-count__tips，只在容器里显示「暂无评论」
  const wrp = root.querySelector(".feed-comment__wrp");
  const wrpText = wrp ? (wrp.innerText || "").replace(/\\s+/g, " ").trim() : "";
  const isEmpty = items === 0 && /暂无评论|还没有评论|暂无数据/.test(wrpText);

  return {
    rendered: items,
    declared: m ? Number(m[1]) : isEmpty ? 0 : null,
    tipText: tipText || (isEmpty ? "暂无评论" : ""),
    isEmpty,
    expandLeft: root.querySelectorAll(".load-more").length,
  };
})()`;

/** 把评论容器滚到底，触发懒加载 */
const SCROLL_BOTTOM = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return { scrolled: false };
  const box = root.querySelector(".feed-comment__wrp")
           || [...root.querySelectorAll("*")].find(e => e.scrollHeight > e.clientHeight + 40 && e.clientHeight > 150);
  if (!box) return { scrolled: false };
  box.scrollTop = box.scrollHeight;
  return { scrolled: true, top: Math.round(box.scrollTop), height: Math.round(box.scrollHeight) };
})()`;

/** 回退一点，制造新的滚动位移（到底后再设 scrollTop 是空操作，不触发加载） */
const SCROLL_NUDGE = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return { scrolled: false };
  const box = root.querySelector(".feed-comment__wrp")
           || [...root.querySelectorAll("*")].find(e => e.scrollHeight > e.clientHeight + 40 && e.clientHeight > 150);
  if (!box) return { scrolled: false };
  box.scrollTop = Math.max(0, box.scrollTop - 400);
  return { scrolled: true, top: Math.round(box.scrollTop) };
})()`;

/**
 * 找到第一个「可以展开」的折叠回复按钮，并把它滚进视口。
 *
 * 实测（2026-10，互动管理/评论）：
 *   - 按钮结构：<div class="load-more"><div class="load-more__btn"><span>展开更多回复</span>
 *                <span class="weui-icon-outlined-arrow"> 或 <img class="infinite-spin">
 *   - 点击监听挂在 **.load-more** 上，不在 .load-more__btn 上
 *   - 只加载一条线程的回复：点一次 → 追加 2~3 条二级评论
 *   - 有 img.infinite-spin = 这条线程的请求还没回来；此时再点会被组件忽略
 *     （handleReplyLoad 里 showReplyLoadingIndex !== -1 直接 return）
 */
const FIND_LOAD_MORE = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return { found: 0, total: 0 };

  const all = [...root.querySelectorAll(".load-more")];
  const info = all.map((el, i) => ({
    i,
    text: (el.innerText || "").replace(/\\s+/g, " ").trim(),
    loading: !!el.querySelector("img"),
    arrow: !!el.querySelector(".weui-icon-outlined-arrow"),
  }));

  const ready = info.find((x) => /展开更多回复|展开\\s*\\d+\\s*条回复|查看更多.*回复/.test(x.text) && x.arrow && !x.loading);
  const busy = info.find((x) => x.loading);
  if (!ready) {
    return { found: 0, total: all.length, loading: busy ? busy.i : null, info };
  }

  const el = all[ready.i];
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  return {
    found: 1,
    i: ready.i,
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    total: all.length,
    info,
  };
})()`;

const EXTRACT = String.raw`(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return { error: "wujie shadow root 不存在" };

  // 文本化：img[alt] 还原成表情文字，剔除 style/script/svg
  const textOf = (el) => {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll("img").forEach((img) => {
      const alt = img.getAttribute("alt");
      img.replaceWith(document.createTextNode(alt ? " " + alt + " " : ""));
    });
    clone.querySelectorAll("style,script,svg").forEach((n) => n.remove());
    return (clone.textContent || "").replace(/\s+/g, " ").trim();
  };

  const items = [...root.querySelectorAll(".comment-item")];

  // 找到某条评论所属的一级评论（自身是嵌套则返回祖先，否则返回自身）
  const topAncestor = (el) => {
    let p = el.parentElement;
    while (p && p !== root) {
      if (p.classList && p.classList.contains("comment-item")) return topAncestor(p);
      p = p.parentElement;
    }
    return el;
  };

  const indexOfEl = new Map(items.map((el, i) => [el, i]));

  const comments = items.map((el, i) => {
    const like = el.querySelector(".like-action");
    const rowEl = el.querySelector(".comment-row");
    const rowText = rowEl ? rowEl.innerText.replace(/\s+/g, " ").trim() : "";
    const author = textOf(el.querySelector(".comment-user-name")) || null;
    const isNested = topAncestor(el) !== el;

    let likes = null;
    if (like) {
      const n = [...like.querySelectorAll("span")].find(
        (s) => !s.classList.contains("weui-desktop-tooltip")
      );
      const t = ((n && n.textContent) || "").trim();
      if (/^\d+$/.test(t)) likes = Number(t);
    }

    return {
      index: i,
      level: isNested ? 2 : 1,
      parentIndex: isNested ? indexOfEl.get(topAncestor(el)) ?? null : null,
      author,
      isAuthor: rowText.includes("作者") && !(author || "").includes("作者"),
      time: textOf(el.querySelector(".comment-time")) || null,
      content: textOf(el.querySelector(".comment-content")) || null,
      likes,
    };
  });

  // 作者是否回复过：看每条一级评论底下有没有作者发的回复
  const enriched = comments.map((c) => {
    if (c.level !== 1) return c;
    const replies = comments.filter((r) => r.parentIndex === c.index);
    const authorReplies = replies.filter((r) => r.isAuthor);
    return {
      ...c,
      replyCount: replies.length,
      authorReplied: authorReplies.length > 0,
      authorReplyCount: authorReplies.length,
      // 作者最近一次回复的时间，便于判断是否需要跟进
      lastAuthorReplyAt: authorReplies.length
        ? authorReplies[authorReplies.length - 1].time
        : null,
    };
  });

  const tips = root.querySelector(".comment-count__tips");
  // 0 评论时没有 .comment-count__tips，只有容器里的「暂无评论」
  const wrpEl = root.querySelector(".feed-comment__wrp");
  const wrpText = wrpEl ? (wrpEl.innerText || "").replace(/\s+/g, " ").trim() : "";
  const isEmpty = items.length === 0 && /暂无评论|还没有评论|暂无数据/.test(wrpText);
  // 记录当前详情区对应的视频，便于事后核对「这批评论属于哪条视频」
  const sel = root.querySelector(".feed-selected-info");
  const selTitle = sel && sel.querySelector(".feed-title");
  const selTime = sel && sel.querySelector(".feed-time");

  return {
    url: location.href,
    video: {
      title: selTitle ? (selTitle.innerText || "").replace(/\s+/g, " ").trim() : null,
      time: selTime ? (selTime.innerText || "").replace(/\s+/g, " ").trim() : null,
    },
    declared: (() => {
      const m = tips ? (tips.innerText || "").match(/(\d+)\s*条/) : null;
      if (m) return Number(m[1]);
      return isEmpty ? 0 : null;
    })(),
    isEmpty,
    total: enriched.length,
    topLevel: enriched.filter((c) => c.level === 1).length,
    replies: enriched.filter((c) => c.level === 2).length,
    comments: enriched,
  };
})()`;

/** 评论容器几何信息（唤醒时发滚轮事件用） */
const COMMENT_BOX = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return null;
  const box = root.querySelector(".feed-comment__wrp");
  if (!box) return null;
  const r = box.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

/** 评论懒加载停住时的唤醒：前台模拟 + 真实滚轮事件 + 贴底 */
async function wakeComments(send) {
  await cdp.ensureVisible(send);
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  const box = await cdp.evaluate(send, COMMENT_BOX).catch(() => null);
  if (box) {
    for (let i = 0; i < 3; i++) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: 1500, pointerType: "mouse",
      }).catch(() => {});
      await cdp.sleep(150);
    }
  }
  await cdp.evaluate(send, SCROLL_NUDGE).catch(() => {});
  await cdp.sleep(120);
  await cdp.evaluate(send, SCROLL_BOTTOM).catch(() => {});
  await cdp.sleep(300);
}

(async () => {
  const pages = await cdp.listPages(PORT);
  const page = pages.find((p) => p.type === "page" && p.url.includes("interaction/comment"));
  if (!page) throw new Error("当前不在评论管理页");

  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);
  try {
    // ★ 页面不可见时懒加载不触发（实测：visibilityState=hidden 时滚动无效）
    if (!NO_SCROLL && !(await cdp.ensureVisible(send))) {
      throw new Error("页面不可见（窗口被最小化），评论懒加载无法触发");
    }

    // ── 滚动加载全部评论 + 展开折叠回复 ────────────────
    // 折叠回复在滚动过程中才会出现，所以两步交替做。
    if (!NO_SCROLL) {
      // 前台模拟：窗口被遮挡时，懒加载/观察器可能被节流
      await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
      await cdp.ensureVisible(send);

      let last = -1;
      let lastGrowth = Date.now();
      let wakeCount = 0;
      let expandedTotal = 0;
      let expandEnabled = true;
      let expandFails = 0;

      for (let i = 0; i < 300; i++) {
        const st = await cdp.evaluate(send, STAT);
        if (!st) throw new Error("找不到评论容器");

        // 已经够数就收工
        if (st.declared !== null && st.rendered >= st.declared) {
          console.log(`已加载全部：${st.rendered}/${st.declared}（${st.tipText}）`);
          break;
        }

        // 先展开折叠回复（点一次只展开一条线程，展开后条数会变，重新统计）
        if (expandEnabled) {
          const lm = await cdp.evaluate(send, FIND_LOAD_MORE);

          // 有线程正在加载：等它回来，别抢着点（组件会忽略加载中的点击）
          if (lm && lm.loading !== null && lm.loading !== undefined) {
            const before = st.rendered;
            let grew = false;
            const dl = Date.now() + 8000;
            while (Date.now() < dl) {
              await cdp.sleep(200);
              const s2 = await cdp.evaluate(send, STAT);
              if (s2 && s2.rendered > before) { grew = true; break; }
            }
            if (!grew) {
              expandFails++;
              if (expandFails >= 2) {
                expandEnabled = false;
                console.log("折叠回复一直停在加载状态，跳过展开（继续滚动）");
              }
            } else {
              lastGrowth = Date.now();
              expandFails = 0;
            }
            continue;
          }

          if (lm && lm.found) {
            await cdp.sleep(250);
            await cdp.clickAt(send, lm.x, lm.y);      // 点 .load-more 中心（监听在这一层）

            const before = st.rendered;
            let grew = false;
            const dl = Date.now() + 7000;
            while (Date.now() < dl) {
              await cdp.sleep(150);
              const s2 = await cdp.evaluate(send, STAT);
              if (s2 && s2.rendered > before) { grew = true; break; }
            }
            if (grew) {
              expandedTotal++;
              lastGrowth = Date.now();
              expandFails = 0;
              continue;
            }
            expandFails++;
            if (expandFails >= 3) {
              expandEnabled = false;
              console.log("折叠回复按钮点击后没有新增，跳过展开（继续滚动）");
            }
          }
        }

        const before = st.rendered;
        if (before > last) {
          last = before;
          lastGrowth = Date.now();
          wakeCount = 0;
        }

        await cdp.evaluate(send, SCROLL_NUDGE);
        await cdp.sleep(120);
        await cdp.evaluate(send, SCROLL_BOTTOM);

        // 自适应等待：一批评论可能 3~5s 才渲染出来，别用固定 500ms 判死
        let grew = false;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          await cdp.sleep(150);
          const s2 = await cdp.evaluate(send, STAT);
          if (s2 && s2.rendered > before) { grew = true; break; }
        }

        if (!grew && Date.now() - lastGrowth > 12000) {
          if (wakeCount >= 1) {
            // 停之前再看一眼折叠按钮：最后一批评论渲染后才可能冒出新的
            // 「展开更多回复」，此时缺口往往只是这几条回复。
            const lm2 = await cdp.evaluate(send, FIND_LOAD_MORE);
            const hasMore = lm2 && (lm2.found || typeof lm2.loading === "number");
            if (hasMore && expandEnabled) {
              lastGrowth = Date.now();
              continue;
            }
            console.log(`停止：${Math.round((Date.now() - lastGrowth) / 1000)}s 无新增，条数稳定在 ${st.rendered}（页面声明 ${st.declared ?? "未知"}）`);
            break;
          }
          wakeCount++;
          console.log(`  ⚠ ${Math.round((Date.now() - lastGrowth) / 1000)}s 无新增（${before} 条）→ 尝试唤醒一次…`);
          await wakeComments(send);
          lastGrowth = Date.now();
        }

        if (i === 299) console.log(`已达最大滚动次数，当前 ${st.rendered} 条`);
      }
      if (expandedTotal) console.log(`共展开折叠回复 ${expandedTotal} 处`);
    }

    const finalStat = await cdp.evaluate(send, STAT).catch(() => null);
    const data = normalizeAuthors(await cdp.evaluate(send, EXTRACT));
    if (data.error) throw new Error(data.error);

    // ── 输出 ───────────────────────────────────────────
    const ok = data.declared === null || data.total >= data.declared;
    const gap = data.declared === null ? 0 : Math.max(0, data.declared - data.total);
    // 折叠已全部展开、列表也到底了还差几条：
    // 实测是服务端 commentCount 把「已删除/审核中」的也算进去了，
    // comment_list 根本不下发，重载也不会变多。小缺口不再触发无意义的重试。
    const unreachable = !ok && gap > 0 && finalStat && finalStat.expandLeft === 0;
    if (unreachable) {
      console.log(
        `\n说明：缺口 ${gap} 条已确认取不到——折叠回复全部展开（剩 0 个），列表也已到底，` +
          `评论接口按页同样只下发 ${data.total} 条。通常是服务端计数包含已删除/审核中的评论。`
      );
    }
    if (data.video && (data.video.title || data.video.time)) {
      console.log(`\n当前视频：${data.video.time || "?"}`);
      console.log(`          ${(data.video.title || "（无标题）").slice(0, 60)}`);
    }
    console.log(
      `\n共 ${data.total} 条评论（页面声明 ${data.declared ?? "?"}）` +
        (ok ? "  ✓ 完整" : "  ⚠ 可能不全")
    );

    const l1 = data.comments.filter((c) => c.level === 1);
    const ownTop = l1.filter((c) => c.isAuthor);
    const replied = l1.filter((c) => c.authorReplied);
    const awaiting = l1.filter((c) => !c.authorReplied && !c.isAuthor);
    const authorReplies = data.comments.filter((c) => c.level === 2 && c.isAuthor).length;

    if (data.total === 0) {
      console.log("该视频暂无评论。\n");
    } else {
      console.log(
        `  一级评论 ${l1.length} 条` +
          (ownTop.length ? `（作者自评 ${ownTop.length}）` : "") +
          `：作者已回复 ${replied.length}，未回复 ${awaiting.length}`
      );
      console.log(`  回复 ${data.replies} 条（其中作者本人 ${authorReplies} 条）\n`);
    }

    // ── 只列未回复的（--unreplied） ──────────────────────
    if (UNREPLIED) {
      if (!awaiting.length) {
        console.log("没有未回复的一级评论。");
      } else {
        console.log(`未回复的一级评论（${awaiting.length} 条）：\n`);
        for (const c of awaiting) {
          console.log(`[${c.index}] ${c.author}  ${c.time}${c.likes !== null ? `  ♡${c.likes}` : ""}`);
          console.log(`     ${c.content}`);
          if (c.replyCount) console.log(`     （有 ${c.replyCount} 条回复，但都不是作者发的）`);
          console.log("");
        }
      }
    } else {
      for (const c of data.comments) {
        if (c.level === 1) {
          const mark = c.authorReplied
            ? `✓ 作者已回复 ${c.authorReplyCount} 次` +
              (c.lastAuthorReplyAt ? `，最近 ${c.lastAuthorReplyAt}` : "")
            : "✗ 作者未回复";
          console.log(`[${c.index}] ${c.author}${c.isAuthor ? "[作者]" : ""}  ${c.time}` +
            `${c.likes !== null ? `  ♡${c.likes}` : ""}`);
          console.log(`     ${c.content}`);
          console.log(`     ${mark}  ·  共 ${c.replyCount || 0} 条回复`);
        } else {
          console.log(`    ↳[${c.index}] ${c.author}${c.isAuthor ? "[作者]" : ""}  ${c.time}  ${c.content}`);
        }
      }
    }

    // 汇总结论写进 JSON，方便后续批量处理
    data.summary = {
      declared: data.declared,
      total: data.total,
      level1: l1.length,
      level2: data.replies,
      ownComments: ownTop.length,
      authorRepliedThreads: replied.length,
      awaitingThreads: awaiting.length,
      authorReplies,
      complete: ok,
      gap,
      leftExpand: finalStat ? finalStat.expandLeft : null,
      unreachable,
      awaitingIndices: awaiting.map((c) => c.index),
    };

    if (OUT) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(data, null, 2), "utf8");
      console.log(`\n已保存：${OUT}`);
    }

    if (!ok) process.exitCode = 2;
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
