#!/usr/bin/env node
/**
 * probe-expand-all.js — 把当前视频里所有「展开更多回复」逐个点开，直到没有按钮
 *
 * 与 06 的区别：不滚动、不判断条数，只做「点开所有折叠」这一件事，
 * 用来验证「页面声明 N 条」是否真的都能取到。
 *
 * 用法：node scripts/probe-expand-all.js
 */

const cdp = require("./lib/cdp");

const COUNT = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return null;
  const tips = root.querySelector(".comment-count__tips");
  const all = [...root.querySelectorAll(".load-more")];
  return {
    items: root.querySelectorAll(".comment-item").length,
    tip: tips ? (tips.innerText || "").trim() : null,
    total: all.length,
    ready: all.filter((e) => e.querySelector(".weui-icon-outlined-arrow") && !e.querySelector("img")).length,
    busy: all.filter((e) => e.querySelector("img")).length,
    threads: all.map((e) => {
      const it = e.closest(".comment-item");
      const u = it && it.querySelector(".comment-user-name");
      return (u ? u.innerText : "?").trim().slice(0, 14);
    }),
  };
})()`;

const CLICK = (idx) => `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  const all = [...root.querySelectorAll(".load-more")];
  const el = all[${idx}];
  if (!el) return null;
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    text: (el.innerText || "").replace(/\\s+/g, " ").trim(),
  };
})()`;

(async () => {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);

  try {
    await cdp.ensureVisible(send);
    let st = await cdp.evaluate(send, COUNT);
    console.log(`起点：DOM ${st.items} 条（${st.tip}），折叠按钮 ${st.total} 个（可点 ${st.ready}，转圈 ${st.busy}）`);
    console.log("线程：", JSON.stringify(st.threads));

    let rounds = 0;
    while (rounds++ < 60) {
      st = await cdp.evaluate(send, COUNT);
      if (st.busy > 0) {
        console.log(`  有 ${st.busy} 个转圈，等 8s…`);
        await cdp.sleep(8000);
        continue;
      }
      if (st.ready === 0) break;

      const before = st.items;
      const box = await cdp.evaluate(send, CLICK(0));
      if (!box) break;
      await cdp.sleep(250);
      await cdp.clickAt(send, box.x, box.y);

      let grew = false;
      const dl = Date.now() + 8000;
      while (Date.now() < dl) {
        await cdp.sleep(200);
        const s2 = await cdp.evaluate(send, COUNT);
        if (s2 && s2.items > before) { grew = true; st = s2; break; }
      }
      console.log(`[${rounds}] 点「${box.text}」：${before} → ${st.items} ${grew ? "✓" : "✗ 无增长"}`);
      if (!grew) {
        // 同一个按钮再试一次；仍不行就把它从可点集合里排除（脚本只按索引点第一个，故记录后人工看）
        console.log("    再试一次…");
        await cdp.clickAt(send, box.x, box.y);
        await cdp.sleep(4000);
        const s3 = await cdp.evaluate(send, COUNT);
        console.log(`    再试后 ${s3.items} 条（可点 ${s3.ready}，转圈 ${s3.busy}）`);
        if (s3.items === before) break;
        st = s3;
      }
    }

    const fin = await cdp.evaluate(send, COUNT);
    console.log(`\n最终：DOM ${fin.items} 条（${fin.tip}），剩 ${fin.total} 个按钮（可点 ${fin.ready}，转圈 ${fin.busy}）`);
    console.log("剩余线程：", JSON.stringify(fin.threads));
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
