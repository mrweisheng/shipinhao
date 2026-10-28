#!/usr/bin/env node
/**
 * capture-window.js — 截图留证（跨平台，走 CDP，不依赖系统截图 API）
 *
 * 旧版 capture-window.ps1 用的是 Windows 的 PrintWindow，macOS 上没有对应物；
 * 而且系统级截图在新版 macOS 要「屏幕录制」权限。这里改用 CDP 的
 * Page.captureScreenshot：抓的是页面本身，跨平台、免授权、结果稳定。
 *
 * 用法：
 *   node scripts/capture-window.js
 *   node scripts/capture-window.js --out .\shots\a.png
 *   node scripts/capture-window.js --url interaction/comment --out .\shots\b.png
 *   node scripts/capture-window.js --full        # 整页（含滚动区域）
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
const has = (n) => argv.includes(`--${n}`);

const PORT = Number(getArg("port", "9222"));
const MATCH = getArg("url", "channels.weixin.qq.com");
const OUT = path.resolve(getArg("out", path.join(__dirname, "..", "shots", `shot-${Date.now()}.png`)));
const FULL = has("full");

async function main() {
  const pages = await cdp.listPages(PORT);
  const page = pages.find((p) => p.type === "page" && String(p.url || "").includes(MATCH));
  if (!page) {
    console.error(`找不到匹配「${MATCH}」的标签页。先跑：node scripts/01-launch-chrome.js`);
    process.exit(3);
  }

  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);
  try {
    const r = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: !!FULL,
    });
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, Buffer.from(r.data, "base64"));
    console.log(`已保存：${OUT}`);
    console.log(`来源页面：${page.url}`);
  } finally {
    close();
  }
}

main().catch((e) => {
  console.error("截图失败：" + e.message);
  process.exit(1);
});
