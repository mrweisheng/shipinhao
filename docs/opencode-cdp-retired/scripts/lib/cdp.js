/**
 * lib/cdp.js — 极简 CDP 客户端（零依赖，Node 22+ 内置 WebSocket）
 *
 * 只用原生 WebSocket 说 CDP 协议，不引入 playwright / puppeteer。
 * 好处：不触发 Runtime.enable 之类的库级痕迹，链路透明可控。
 */

const http = require("http");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读取调试端口的标签页列表（纯 HTTP，不建立 CDP 会话） */
function listPages(port = 9222) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/json/list", timeout: 4000 }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        try { resolve(JSON.parse(b)); } catch { reject(new Error("非 JSON: " + b.slice(0, 150))); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("调试端口超时")));
    req.on("error", reject);
  });
}

/** 关闭某个标签页（纯 HTTP）。不要用 fetch —— Node 24 在退出时可能触发 libuv 断言。 */
function closeTarget(port, id) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: `/json/close/${id}`, timeout: 3000 }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("timeout", () => { req.destroy(); resolve(); });
    req.on("error", () => resolve());
  });
}

/** 连接某个页面 target，返回 { send, on, close } */
async function attach(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();   // eventName -> Set<fn>

  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    if (msg.method && listeners.has(msg.method)) {
      for (const fn of listeners.get(msg.method)) {
        try { fn(msg.params); } catch { /* 事件回调不打断主流程 */ }
      }
    }
  });

  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("WebSocket 连接失败")), { once: true });
  });

  const send = (method, params = {}, { timeout = 15000 } = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP 超时（${timeout}ms）：${method}`));
      }, timeout);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
    });

  return {
    send,
    /** 订阅 CDP 事件（如 Network.requestWillBeSent），返回取消订阅函数 */
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
    close: () => { try { ws.close(); } catch {} },
  };
}

/** 在页面主世界执行 JS，返回结果值 */
async function evaluate(send, expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result.value;
}

/** 在指定坐标派发一次真实鼠标点击（CDP Input 注入，不动系统光标） */
async function clickAt(send, x, y) {
  const base = { x, y, button: "left", clickCount: 1 };
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await sleep(60);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await sleep(40);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
}

/** 把鼠标悬停到坐标（用于展开二级菜单） */
async function hoverAt(send, x, y) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
}

/** 轮询直到表达式返回真值 */
async function waitFor(send, expression, { timeout = 8000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(send, expression);
      if (last) return last;
    } catch (e) { last = e.message; }
    await sleep(interval);
  }
  throw new Error(`等待超时（${timeout}ms）：${expression.slice(0, 80)}`);
}

/**
 * 确保页面可见。
 *
 * ★ 实测结论：视频号后台的列表是懒加载，页面 visibilityState 为 hidden 时
 *   （窗口被最小化或切到后台），滚动**不会**触发加载，表现为"加载动画一直转但没数据"。
 *   因此任何滚动类操作前都必须先确保页面可见。
 */
async function ensureVisible(send, { tries = 12, interval = 250 } = {}) {
  let v = await evaluate(send, "document.visibilityState");
  if (v === "visible") return true;

  try { await send("Page.bringToFront", {}); } catch { /* 忽略 */ }

  for (let i = 0; i < tries; i++) {
    v = await evaluate(send, "document.visibilityState");
    if (v === "visible") return true;
    await sleep(interval);
  }
  return false;
}

/**
 * 按「可见文本」定位元素，返回视口坐标中心点。
 * 只认可见、有尺寸、文本完全匹配的**最深层**元素，避免匹配到一大片容器。
 *
 * 默认同时搜索 document 与 wujie 的 shadowRoot：
 * 视频号后台的内容区在 shadowRoot 里，只查 document 会找不到评论区的按钮。
 */
function findByTextExpr(text, { exact = true, container = null } = {}) {
  return `(() => {
    const norm = (s) => (s || "").replace(/\\s+/g, "").trim();
    const target = ${JSON.stringify(text.replace(/\s+/g, ""))};
    const explicit = ${container === null ? "null" : container};
    const roots = [];
    if (explicit) {
      roots.push(explicit);
    } else {
      roots.push(document);
      const host = document.querySelector("wujie-app");
      if (host && host.shadowRoot) roots.push(host.shadowRoot);
    }

    const hits = [];
    for (const root of roots) {
      for (const el of root.querySelectorAll("a,li,div,span,button")) {
        const t = norm(el.textContent);
        const ok = ${exact ? "t === target" : "t.includes(target)"};
        if (!ok) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 5 || r.height < 5) continue;
        const st = getComputedStyle(el);
        if (st.visibility === "hidden" || st.display === "none" || parseFloat(st.opacity) === 0) continue;
        // 元素中心必须落在视口内
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
        hits.push({ el, r, area: r.width * r.height });
      }
    }
    if (!hits.length) return null;
    // 面积最小（最深）的那个是真正可点的叶子节点
    hits.sort((a, b) => a.area - b.area);
    const { r, el } = hits[0];
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || "").slice(0, 60),
      text: norm(el.textContent).slice(0, 30),
    };
  })()`;
}

module.exports = { sleep, listPages, closeTarget, attach, evaluate, clickAt, hoverAt, waitFor, ensureVisible, findByTextExpr };
