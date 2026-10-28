#!/usr/bin/env node
/**
 * 02-watch-login.js
 *
 * 监测视频号登录状态。
 *
 * ★ 关键设计：全程只用 HTTP 轮询 Chrome 的 /json/list，
 *   不建立任何 CDP 会话，不发 Runtime.enable。
 *   对页面来说，这个进程根本不存在 —— 零自动化痕迹。
 *
 * 用法：
 *   node scripts/02-watch-login.js
 *   node scripts/02-watch-login.js --timeout=300 --interval=2
 *
 * 退出码：
 *   0  登录成功
 *   2  超时仍未登录
 *   3  找不到视频号标签页（浏览器未启动或页面被关）
 */

const http = require("http");

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : def;
};

const PORT = Number(opt("port", 9222));
const TIMEOUT = Number(opt("timeout", 300));   // 秒
const INTERVAL = Number(opt("interval", 2));   // 秒

const HOST_HINT = "channels.weixin.qq.com";

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port: PORT, path, timeout: 3000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error("返回非 JSON：" + body.slice(0, 120))); }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
  });
}

/** 把 URL 归类成登录状态 */
function classify(url) {
  if (!url.includes(HOST_HINT)) return null;
  if (/\/login/i.test(url)) return "login";
  if (/\/platform\//i.test(url) || /\/platform\/?$/i.test(url)) return "platform";
  if (/\/mobile\//i.test(url)) return "mobile";
  return "other";
}

const stamp = () => new Date().toTimeString().slice(0, 8);

(async () => {
  const deadline = Date.now() + TIMEOUT * 1000;
  let last = null;
  let missCount = 0;

  console.log(`[${stamp()}] 开始监测登录状态（端口 ${PORT}，最长 ${TIMEOUT}s）`);
  console.log(`[${stamp()}] 模式：纯 HTTP 轮询 /json/list，不挂 CDP`);
  console.log("");

  while (Date.now() < deadline) {
    let tabs;
    try {
      tabs = await getJson("/json/list");
      missCount = 0;
    } catch (e) {
      missCount++;
      if (missCount === 1) {
        console.log(`[${stamp()}] ! 连不上调试端口：${e.message}`);
        console.log(`[${stamp()}]   请先运行 scripts\\01-launch-clean-chrome.ps1`);
      }
      if (missCount > 15) process.exit(3);
      await new Promise((r) => setTimeout(r, INTERVAL * 1000));
      continue;
    }

    const pages = tabs.filter((t) => t.type === "page" && t.url.includes(HOST_HINT));

    if (pages.length === 0) {
      if (last !== "none") {
        console.log(`[${stamp()}] 未找到视频号标签页（可能已关闭或在别的窗口）`);
        last = "none";
      }
      await new Promise((r) => setTimeout(r, INTERVAL * 1000));
      continue;
    }

    const tab = pages[0];
    const state = classify(tab.url);
    const key = `${state}|${tab.url}`;

    if (key !== last) {
      printState(state, tab);
      last = key;
    }

    if (state === "platform") {
      console.log("");
      console.log(`[${stamp()}] ✓ 登录成功，页面已进入后台`);
      console.log(`            URL : ${tab.url}`);
      console.log("");
      console.log("下一步：挂 MCP 读取页面内容（见 试验记录.md 阶段 3）");
      process.exit(0);
    }

    await new Promise((r) => setTimeout(r, INTERVAL * 1000));
  }

  console.log("");
  console.log(`[${stamp()}] ✗ 超时（${TIMEOUT}s）：仍未检测到登录成功`);
  process.exit(2);
})();

function printState(state, tab) {
  const map = {
    login:    ["等待扫码", "页面在登录页。请用微信扫码并确认。"],
    platform: ["已登录", ""],
    mobile:   ["移动端页面", "疑似被识别为手机 UA，需检查。"],
    other:    ["其他视频号页面", ""],
  };
  const [label, hint] = map[state] || ["未知", ""];
  console.log(`[${stamp()}] ${state.toUpperCase().padEnd(8)} ${label}`);
  console.log(`            URL : ${tab.url}`);
  if (hint) console.log(`            提示: ${hint}`);
}
