#!/usr/bin/env node
/**
 * probe-stability.js — 重复同一场景，统计成功率（找偶发 bug）
 *
 * 场景：评论页 → 直接改地址去草稿箱 → 立刻读第 150 条
 * 每轮打印结果；失败时把完整日志存 data/probe/stability-<n>.txt
 *
 * 用法：node scripts/probe-stability.js --times 5 --nth 150
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const cdp = require("./lib/cdp");
const nav = require("./lib/nav");

const ROOT = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const getArg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const TIMES = Number(getArg("times", "5"));
const NTH = getArg("nth", "150");
const AWAY = getArg("away", "https://channels.weixin.qq.com/platform/post/draftListManager");

(async () => {
  let pass = 0;
  for (let i = 1; i <= TIMES; i++) {
    // 回到评论页
    const pages = await cdp.listPages(9222);
    const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
    const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);
    try {
      await cdp.ensureVisible(send);
      const u = await cdp.evaluate(send, "location.href");
      if (!u.includes("/interaction/comment")) {
        await nav.clickMenuPath(send, "互动管理", "评论");
        await cdp.sleep(1500);
      }
      await cdp.evaluate(send, `location.href = ${JSON.stringify(AWAY)}`);
      // 等外壳挂载
      for (let k = 0; k < 60; k++) {
        await cdp.sleep(300);
        const ok = await cdp
          .evaluate(send, `document.querySelectorAll(".finder-ui-desktop-menu__link").length > 4`)
          .catch(() => false);
        if (ok) break;
      }
    } finally {
      close();
    }

    const t0 = Date.now();
    const r = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "07-read-video.js"), "--nth", NTH, "--json",
        path.join(ROOT, "data", "probe", `stability-${i}.json`), "--wait", "0"],
      { cwd: ROOT, encoding: "utf8", timeout: 300000, maxBuffer: 64 * 1024 * 1024 }
    );
    const ms = Date.now() - t0;
    const ok = r.status === 0;
    if (ok) pass++;
    else {
      const logFile = path.join(ROOT, "data", "probe", `stability-${i}.txt`);
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, (r.stdout || "") + (r.stderr || ""), "utf8");
    }
    const tail = (r.stdout || "").trim().split("\n").slice(-1)[0];
    console.log(`${ok ? "✓" : "✗"} 第 ${i} 次  ${(ms / 1000).toFixed(1)}s  ${ok ? tail : "日志见 data/probe/"}`);
    await new Promise((res) => setTimeout(res, 1200));
  }
  console.log(`\n成功率：${pass}/${TIMES}`);
  process.exitCode = pass === TIMES ? 0 : 1;
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
