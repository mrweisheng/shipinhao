/**
 * lib/login.js — 任务开始前的登录状态检查
 *
 * 设计约束：
 *   - 只用 HTTP 轮询 Chrome 的 /json/list，不建立 CDP 会话（零自动化痕迹）
 *   - 不假设登录态能留存：每次都查，未登录就明确提醒用户扫码
 *   - 不假设账号、不写死页面路径细节，只按 URL 归类
 *
 * 退出码约定（由调用方使用）：
 *   0 已登录    3 浏览器/标签页不可用    2 等待扫码超时
 */

const http = require("http");

const HOST_HINT = "channels.weixin.qq.com";

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, timeout: 3000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("调试端口返回非 JSON"));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("调试端口无响应（超时）")));
    req.on("error", reject);
  });
}

/** 按 URL 判断页面属于哪个阶段 */
function classify(url) {
  if (!url || !url.includes(HOST_HINT)) return "unknown";
  if (/\/login/i.test(url)) return "login";
  if (/\/platform(\/|$)/i.test(url)) return "platform";
  if (/\/mobile\//i.test(url)) return "mobile";
  return "other";
}

/**
 * 只读一次状态，不等待。
 * 返回 { ok, state, url, tab, tabs, error }
 */
async function inspect(port = 9222) {
  let tabs;
  try {
    tabs = await getJson(port, "/json/list");
  } catch (e) {
    return { ok: false, state: "no-browser", url: null, tab: null, tabs: [], error: e.message };
  }

  const pages = tabs.filter((t) => t.type === "page" && (t.url || "").includes(HOST_HINT));
  if (!pages.length) return { ok: false, state: "no-tab", url: null, tab: null, tabs: [], error: null };

  // 优先选已经在后台的标签页；否则选登录页
  const platform = pages.find((p) => classify(p.url) === "platform");
  const login = pages.find((p) => classify(p.url) === "login");
  const tab = platform || login || pages[0];

  return {
    ok: classify(tab.url) === "platform",
    state: classify(tab.url),
    url: tab.url,
    tab,
    tabs: pages,
    error: null,
  };
}

const stamp = () => new Date().toTimeString().slice(0, 8);

/**
 * 开始任务前调用：已登录立即返回；未登录则打印醒目提示并（可选）等待扫码。
 *
 * @param {object} opt
 * @param {number} opt.port     调试端口，默认 9222
 * @param {number} opt.wait     未登录时最多等待多少秒，0 = 不等待直接返回（默认 300）
 * @param {function} opt.log    日志函数，默认 console.log
 * @returns {Promise<{ok:boolean, state:string, url:string|null, waited:number, code:number}>}
 *          code：0 已登录 / 3 浏览器或标签页不可用 / 2 等待超时
 */
async function requireLogin({ port = 9222, wait = 300, log = console.log } = {}) {
  const t0 = Date.now();
  const elapsed = () => Math.round((Date.now() - t0) / 1000);

  let printedBanner = false;
  let lastState = null;
  let lastNote = 0;

  const printBanner = (state, url) => {
    log("");
    log("============================================================");
    if (state === "login") {
      log("  ⚠ 未登录：请用微信扫描屏幕上的二维码登录视频号助手");
      log("     登录完成后脚本会自动继续，不需要回来按任何键");
    } else if (state === "no-tab") {
      log("  ⚠ 没找到视频号标签页");
      log("     请打开一个 Chrome 标签页访问 channels.weixin.qq.com 并扫码登录");
    } else if (state === "no-browser") {
      log("  ⚠ 连不上 Chrome 调试端口");
      log("     请先运行：scripts\\01-launch-clean-chrome.ps1");
    } else if (state === "mobile") {
      log("  ⚠ 当前是移动端页面，请在电脑版后台登录");
    } else {
      log(`  ⚠ 未登录或页面不在后台（state=${state}），请扫码登录`);
    }
    if (url) log(`     当前页面：${url}`);
    if (wait > 0) log(`     最长等待 ${wait} 秒…`);
    log("============================================================");
    log("");
  };

  // 最多等 wait 秒；wait=0 时只查一次
  const deadline = t0 + Math.max(0, wait) * 1000;
  for (;;) {
    const st = await inspect(port);

    if (st.ok) {
      if (lastState !== "platform") {
        log(`[${stamp()}] ✓ 已登录：${st.url}`);
      }
      return { ok: true, state: "platform", url: st.url, waited: elapsed(), code: 0 };
    }

    if (st.state !== lastState) {
      printBanner(st.state, st.url);
      printedBanner = true;
      lastState = st.state;
    } else if (st.state === "login" && Date.now() - lastNote > 30000) {
      lastNote = Date.now();
      log(`[${stamp()}] 仍在等待扫码登录…（已等 ${elapsed()}s）`);
    }

    // 浏览器没起来 / 没有标签页：等下去也没意义，直接返回让用户处理
    if (st.state === "no-browser" || st.state === "no-tab") {
      return { ok: false, state: st.state, url: st.url, waited: elapsed(), code: 3 };
    }

    if (Date.now() >= deadline) {
      if (!printedBanner) printBanner(st.state, st.url);
      log(`[${stamp()}] ✗ 等待 ${wait}s 仍未登录`);
      return { ok: false, state: st.state, url: st.url, waited: elapsed(), code: 2 };
    }

    await new Promise((r) => setTimeout(r, 1500));
  }
}

module.exports = { inspect, classify, requireLogin };
