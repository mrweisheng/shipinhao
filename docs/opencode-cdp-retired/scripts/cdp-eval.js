#!/usr/bin/env node
/**
 * cdp-eval.js — 在页面里执行 JS 并打印结果（零依赖，Node 22+ 内置 WebSocket）
 *
 * 设计原则：
 *   1. 只发 Runtime.evaluate，不调用 Runtime.enable —— 减少自动化痕迹。
 *   2. 默认输出结构化 JSON，方便后续程序处理，而不是靠人看截图。
 *   3. 可选 --shot 截图，仅用于留证/给人看，不参与任何判断逻辑。
 *
 * 用法：
 *   node scripts/cdp-eval.js --expr "document.title"
 *   node scripts/cdp-eval.js --file scripts/queries/login-state.js
 *   node scripts/cdp-eval.js --expr "document.body.innerText.slice(0,200)" --shot .\shots\a.png
 *
 * 参数：
 *   --expr <code>     直接执行一段表达式
 *   --file <path>     执行文件内容（适合较长的查询）
 *   --url <substr>    只匹配 URL 含该子串的标签页，默认 channels.weixin.qq.com
 *   --port <n>        调试端口，默认 9222
 *   --shot <path>     顺带把当前视口截图存到该路径
 *   --timeout <ms>    默认 15000
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const getArg = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.split("=").slice(1).join("=") : def;
};

const PORT = Number(getArg("port", 9222));
const MATCH = getArg("url", "channels.weixin.qq.com");
const TIMEOUT = Number(getArg("timeout", 15000));
const SHOT = getArg("shot", null);

function httpJson(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: p, timeout: 4000 }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        try { resolve(JSON.parse(b)); } catch { reject(new Error("非 JSON 响应: " + b.slice(0, 150))); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("连接调试端口超时")));
    req.on("error", reject);
  });
}

async function main() {
  let expr = getArg("expr");
  const file = getArg("file");
  if (file) expr = fs.readFileSync(file, "utf8");
  if (!expr) throw new Error("必须提供 --expr 或 --file");

  const targets = await httpJson("/json/list");
  const pages = targets.filter((t) => t.type === "page" && t.url.includes(MATCH));
  if (!pages.length) {
    const all = targets.filter((t) => t.type === "page").map((t) => t.url);
    throw new Error(`没有匹配 "${MATCH}" 的标签页。当前页面：\n  ` + all.join("\n  "));
  }
  const tab = pages[0];

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const open = new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", (e) => rej(new Error("WebSocket 连接失败: " + e.message)), { once: true });
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });

  const timer = setTimeout(() => { try { ws.close(); } catch {} }, TIMEOUT);

  await open;

  const r = await send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });

  let out;
  if (r.exceptionDetails) {
    out = { ok: false, error: r.exceptionDetails.text, detail: r.exceptionDetails.exception?.description };
  } else {
    out = { ok: true, url: tab.url, title: tab.title, value: r.result.value };
  }

  if (SHOT) {
    const s = await send("Page.captureScreenshot", { format: "png" });
    const dir = path.dirname(SHOT);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SHOT, Buffer.from(s.data, "base64"));
    out.screenshot = SHOT;
  }

  console.log(JSON.stringify(out, null, 2));

  clearTimeout(timer);
  ws.close();
  process.exit(out.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }, null, 2));
  process.exit(1);
});
