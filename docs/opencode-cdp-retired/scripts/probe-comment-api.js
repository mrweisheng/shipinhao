#!/usr/bin/env node
/**
 * probe-comment-api.js — 抓 comment_list 的返回体，看「共 N 条」和实际返回多少
 *
 * 用法：node scripts/probe-comment-api.js --nth 169
 */

const cdp = require("./lib/cdp");
const channels = require("./lib/channels");

const argv = process.argv.slice(2);
const getArg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const NTH = Number(getArg("nth", "169"));

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
        bodies.push({ url: r.url, postData: r.postData, body: b.body, b64: b.base64Encoded });
      } catch (e) {
        bodies.push({ url: r.url, error: e.message });
      }
    });

    await cdp.ensureVisible(send);
    console.log(`打开第 ${NTH} 条视频…`);

    // 确保在列表位置
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

    // 滚评论到底，多等几轮
    for (let i = 0; i < 30; i++) {
      await cdp.sleep(1000);
      const st = await cdp.evaluate(send, `(() => {
        const host = document.querySelector("wujie-app");
        const root = host && host.shadowRoot;
        const wrp = root && root.querySelector(".feed-comment__wrp");
        if (!wrp) return null;
        let sc = wrp;
        while (sc && sc !== root && !(sc.scrollHeight > sc.clientHeight + 20)) sc = sc.parentElement;
        const tips = root.querySelector(".comment-count__tips");
        return { items: root.querySelectorAll(".comment-item").length, tip: tips ? (tips.innerText||"").trim() : null, bottom: sc && sc !== root ? Math.round(sc.scrollTop + sc.clientHeight) >= Math.round(sc.scrollHeight) - 5 : null };
      })()`).catch(() => null);
      if (st) console.log(`  t+${i}s  ${st.items} 条 ${st.tip || ""} ${st.bottom ? "已到底" : ""}`);
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
      if (st && st.tip && st.items >= Number((st.tip.match(/(\d+)/) || [])[1] || 1e9)) break;
    }
    await cdp.sleep(2000);

    console.log(`\ncomment_list 请求 ${bodies.length} 次：`);
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "..", "data", "probe");
    fs.mkdirSync(dir, { recursive: true });
    bodies.forEach((b, i) => {
      let txt = b.body;
      if (b.b64) txt = Buffer.from(txt, "base64").toString("utf8");
      fs.writeFileSync(path.join(dir, `comment-api-${i + 1}.json`), txt, "utf8");
      fs.writeFileSync(
        path.join(dir, `comment-api-${i + 1}.req.json`),
        JSON.stringify({ url: b.url, postData: b.postData }, null, 2),
        "utf8"
      );
      console.log(`已保存 data/probe/comment-api-${i + 1}.json`);
    });
    for (const b of bodies) {
      console.log(`\n--- ${b.url.slice(0, 130)}`);
      if (b.postData) console.log("请求体：" + String(b.postData).slice(0, 300));
      if (b.error) { console.log("取返回体失败：" + b.error); continue; }
      let txt = b.body;
      if (b.b64) txt = Buffer.from(txt, "base64").toString("utf8");
      console.log(`返回体 ${txt.length} 字符，前 600：`);
      console.log(txt.slice(0, 600));
    }
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
