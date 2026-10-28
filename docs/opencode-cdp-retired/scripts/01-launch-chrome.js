#!/usr/bin/env node
/**
 * 01-launch-chrome.js — 干净启动 Chrome（跨平台：Windows / macOS / Linux）
 *
 * 与旧版 01-launch-clean-chrome.ps1 行为一致，但只维护一份代码：
 *   - 独立 profile（不碰你日常用的 Chrome）
 *   - 开调试端口 9222
 *   - 强制直连（--no-proxy-server），避免出境 IP 触发风控
 *   - 关闭后台节流，窗口被遮挡时页面 JS 仍正常跑
 *   - 不带 --enable-automation → navigator.webdriver = false
 *
 * 已有实例在跑时**只新开标签页**，不会重复启动（macOS 上重复启动会直接退出）。
 *
 * 用法：
 *   node scripts/01-launch-chrome.js
 *   node scripts/01-launch-chrome.js --url https://channels.weixin.qq.com/login.html
 *   node scripts/01-launch-chrome.js --port 9333 --profile .\profile-b
 *   node scripts/01-launch-chrome.js --use-proxy        # 需要走梯子时显式加（不推荐）
 *   node scripts/01-launch-chrome.js --dry-run          # 只报告，不启动
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return d;
};
const has = (n) => argv.includes(`--${n}`);

const PORT = Number(getArg("port", "9222"));
const URL_TO_OPEN = getArg("url", "https://channels.weixin.qq.com/login.html");
const PROFILE = path.resolve(getArg("profile", path.join(__dirname, "..", "profile")));
const USE_PROXY = has("use-proxy");
const DRY = has("dry-run");

function chromeCandidates() {
  const p = os.platform();
  if (p === "win32") {
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA || "";
    return [
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      local && path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    ].filter(Boolean);
  }
  if (p === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
}

function findChrome() {
  for (const p of chromeCandidates()) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function httpGetJson(host, port, urlPath, timeout = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: urlPath, timeout }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

function openTab(port, url) {
  return new Promise((resolve) => {
    // 新版 Chrome 要求 PUT /json/new
    const req = http.request({ host: "127.0.0.1", port, path: `/json/new?${encodeURIComponent(url)}`, method: "PUT", timeout: 4000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
    req.on("error", () => resolve(0));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const exe = findChrome();
  if (!exe) {
    console.error("找不到 Chrome。已尝试：");
    for (const p of chromeCandidates()) console.error("  " + p);
    console.error("请安装 Chrome，或用 --profile 指定一个已安装的浏览器路径。");
    process.exit(1);
  }

  const running = await httpGetJson("127.0.0.1", PORT, "/json/version");
  if (running) {
    console.log("已有 Chrome 实例在调试端口上，复用（只新开标签页）");
    console.log(`  Browser : ${running.Browser}`);
    console.log(`  端口    : ${PORT}`);
    if (!DRY) {
      const code = await openTab(PORT, URL_TO_OPEN);
      console.log(code && code < 400 ? `  已新开标签页：${URL_TO_OPEN}` : "  新开标签页失败（可手动打开）");
    }
    return;
  }

  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--start-maximized",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ];
  if (!USE_PROXY) args.push("--no-proxy-server");
  args.push(URL_TO_OPEN);

  console.log("启动 Chrome：");
  console.log(`  可执行文件 : ${exe}`);
  console.log(`  profile    : ${PROFILE}`);
  console.log(`  调试端口   : ${PORT}`);
  console.log(`  网络       : ${USE_PROXY ? "跟随系统代理" : "强制直连"}`);
  console.log(`  目标       : ${URL_TO_OPEN}`);

  if (DRY) {
    console.log("\n（--dry-run：未真正启动）");
    return;
  }

  const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();

  let info = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    info = await httpGetJson("127.0.0.1", PORT, "/json/version");
    if (info) break;
  }
  if (!info) {
    console.error("\n[失败] 30 秒内调试端口没起来。可能原因：");
    console.error("  - profile 被另一个 Chrome 占用（先完全退出那个实例）");
    console.error("  - 端口被别的程序占用（用 --port 换一个）");
    process.exit(1);
  }
  console.log("\n[OK] Chrome 已启动");
  console.log(`  Browser : ${info.Browser}`);
  console.log(`  WS      : ${info.webSocketDebuggerUrl}`);
  console.log("\n下一步：node scripts/26-whoami.js   （确认当前登录的是哪个账号）");
}

main();
