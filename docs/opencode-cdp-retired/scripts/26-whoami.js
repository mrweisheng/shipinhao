#!/usr/bin/env node
/**
 * 26-whoami.js — 读出当前登录的视频号账号名
 *
 * 为什么需要它：同一时刻只可能有一个账号在线，但人手动切号后，
 * 脚本并不知道页面已经换了人。所有写入前都应该先确认「现在是谁」。
 *
 * 读法（自适应，见 lib/ui.js）：
 *   1. 先读登记过的选择器（默认 `.account-info .name`），在任何后台页面都有效
 *   2. 选择器失效 → 用结构启发式 / 已登记账号名反查
 *   3. 新选择器自动写回 `data/ui-map.json`，下次直接用
 *   不再从页面尾部猜文字（旧做法会读到页脚「关于腾讯微信视频号运营规范问题咨询」）。
 *
 * 用法：
 *   node scripts/26-whoami.js
 *   node scripts/26-whoami.js --expect 明哥揾粤港车    # 不一致则退出码 3
 *   node scripts/26-whoami.js --nav                  # 不在评论页时先跳过去再确认
 *
 * 退出码：0 成功（或与 --expect 一致）/ 1 未登录 / 3 账号不匹配或读不到
 */

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

    if (NAV && !ui.isCommentUrl(page.url)) {
      const nav = await ui.ensureCommentPageOnPage(send, { log: (m) => console.error(`[ui] ${m}`) });
      if (!nav.ok) {
        console.error(`进不去评论管理页（当前 ${nav.url || "?"}）`);
        process.exit(3);
      }
    }

    const r = await ui.resolveAccountOnPage(send);
    if (!r || !r.name) {
      console.error(`读不到账号名（当前页面 ${r ? r.url : "?"}）`);
      process.exit(3);
    }

    console.log(r.name);
    if (!ui.isCommentUrl(r.url)) {
      console.error(`[提示] 当前不在评论管理页：${r.url}（账号名仍可靠；加 --nav 可自动跳转）`);
    }

    if (EXPECT && !String(r.name).includes(EXPECT)) {
      console.error(`[失败] 当前账号「${r.name}」与预期的「${EXPECT}」不一致`);
      process.exit(3);
    }
  } finally {
    close();
  }
})().catch((e) => {
  console.error(`[失败] ${e.message}`);
  process.exit(3);
});
