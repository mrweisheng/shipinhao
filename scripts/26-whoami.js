#!/usr/bin/env node
/**
 * 26-whoami.js — 读出当前登录的视频号账号名
 *
 * 为什么需要它：同一时刻只可能有一个账号在线，但人手动切号后，
 * 脚本并不知道页面已经换了人。所有写入前都应该先确认「现在是谁」。
 *
 * 2026-11-01 修正（用户要求）：
 *   - 不再在评论页猜账号名。**先切到首页**读 `.account-info .name`，读完再回原页面。
 *   - 读到后写 `data/account-session.json`；`13 --send` 只读这个 session，
 *     不在评论页再读账号（评论页侧边栏折叠，读不到）。
 *   - 评论区「作者」前缀只作为首页读取失败时的兜底，且出现多个作者名时不猜。
 *
 * 用法：
 *   node scripts/26-whoami.js
 *   node scripts/26-whoami.js --expect 明哥揾粤港车    # 不一致则退出码 3
 *   node scripts/26-whoami.js --nav                  # 读完后再跳到评论页
 *
 * 退出码：0 成功（或与 --expect 一致）/ 1 未登录 / 3 账号不匹配或读不到
 */

const fs = require("fs");
const path = require("path");
const cdp = require("./lib/cdp");
const ui = require("./lib/ui");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return d;
};
const has = (n) => argv.includes(`--${n}`);

const EXPECT = getArg("expect", null);
const PORT = Number(getArg("port", 9222));
const NAV = has("nav");
const HOME = "https://channels.weixin.qq.com/platform/";
const SESSION = path.join(__dirname, "..", "data", "account-session.json");

(async () => {
  const pages = await cdp.listPages(PORT).catch(() => []);
  const cands = pages.filter((p) => p.type === "page" && String(p.url).includes("channels.weixin.qq.com"));
  if (!cands.length) {
    console.error("读不到页面状态（浏览器未启动或没有视频号标签页）");
    process.exit(3);
  }
  const page = cands.find((p) => ui.isCommentUrl(p.url)) || cands[0];

  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);
  try {
    if (String(page.url).includes("/login")) {
      console.error("未登录：请先扫码登录");
      process.exit(1);
    }

    const url0 = await cdp.evaluate(send, "location.href");
    const onHome = /^https:\/\/channels\.weixin\.qq\.com\/platform\/?(?:[?#].*)?$/.test(String(url0));
    let navigated = false;
    let restored = false;

    const restore = async () => {
      if (restored) return;
      restored = true;
      if (NAV) {
        await ui.ensureCommentPageOnPage(send, { log: (m) => console.error(`[ui] ${m}`) });
      } else if (navigated && url0) {
        await cdp.evaluate(send, `location.href = ${JSON.stringify(url0)}`);
        await cdp.sleep(800);
      }
    };

    try {
      // 关键：先在首页读账号。评论页侧边栏折叠，读不到，也不能靠猜。
      if (!onHome) {
        navigated = true;
        await cdp.evaluate(send, `location.href = ${JSON.stringify(HOME)}`);
        // 网络差时首页会空白：先确保页面挂载，再等账号卡片
        await ui.ensurePageReady(send, { tries: 3 });
        // 首页是 SPA，跳过去后要等它把账号卡片挂出来（实测可能要 10s+）
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const ready = await cdp
            .evaluate(send, `!!document.querySelector(".finder-nickname, .account-info .name")`)
            .catch(() => false);
          if (ready) break;
          await cdp.sleep(500);
        }
      }

      const r = await ui.resolveAccountOnPage(send, { waitMs: 15000 });
      if (!r || !r.name) {
        await restore();
        console.error(`读不到账号名（当前页面 ${r ? r.url : "?"}）`);
        process.exit(3);
      }

      fs.mkdirSync(path.dirname(SESSION), { recursive: true });
      fs.writeFileSync(
        SESSION,
        JSON.stringify({ name: r.name, at: new Date().toISOString(), url: r.url, source: "home" }, null, 2),
        "utf8"
      );

      await restore();
      console.log(r.name);
      if (EXPECT && !String(r.name).includes(EXPECT)) {
        console.error(`[失败] 当前账号「${r.name}」与预期的「${EXPECT}」不一致`);
        process.exit(3);
      }
    } catch (e) {
      await restore().catch(() => {});
      throw e;
    }
  } finally {
    close();
  }
})().catch((e) => {
  console.error(`[失败] ${e.message}`);
  process.exit(3);
});
