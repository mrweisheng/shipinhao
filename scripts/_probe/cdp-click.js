#!/usr/bin/env node
/**
 * cdp-click.js — 通用点击工具
 *
 * 支持两种定位：
 *   --text "退出登录"   按可见文本点（最深层、最小的匹配元素）
 *   --x 168 --y 691    按坐标点
 *
 * 点击走 CDP Input 注入真实鼠标事件：不移动系统光标、不抢窗口焦点。
 * --dry 只打印命中位置，不真的点（重要操作先试跑）。
 *
 * 用法：
 *   node scripts/cdp-click.js --text "退出登录" --dry
 *   node scripts/cdp-click.js --text "退出登录"
 */

const cdp = require("./lib/cdp");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return d;
};

const PORT = Number(getArg("port", 9222));
const TEXT = getArg("text", null);
const X = getArg("x", null);
const Y = getArg("y", null);
const DRY = argv.includes("--dry");
const MATCH = getArg("url", "channels.weixin.qq.com");

(async () => {
  const pages = await cdp.listPages(PORT);
  const page = pages.find((p) => p.type === "page" && p.url.includes(MATCH));
  if (!page) throw new Error(`没找到包含 "${MATCH}" 的标签页`);

  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);
  try {
    let pos;
    if (TEXT) {
      pos = await cdp.evaluate(send, cdp.findByTextExpr(TEXT));
      if (!pos) throw new Error(`没找到可见文本「${TEXT}」`);
    } else if (X !== null && Y !== null) {
      pos = { x: Number(X), y: Number(Y), tag: "coord", cls: "", text: "" };
    } else {
      throw new Error("需要 --text 或 --x/--y");
    }

    // 点之前确认该坐标上真的是目标元素，避免被浮层挡住点错
    // 注意：内容在 wujie 的 shadowRoot 里，document.elementFromPoint 只会返回宿主元素
    const hit = await cdp.evaluate(
      send,
      `(() => {
        const host = document.querySelector("wujie-app");
        const sr = host && host.shadowRoot;
        const el =
          (sr && typeof sr.elementFromPoint === "function" && sr.elementFromPoint(${pos.x}, ${pos.y})) ||
          document.elementFromPoint(${pos.x}, ${pos.y});
        if (!el) return null;
        return { tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 50),
                 text: (el.innerText || "").trim().slice(0, 30) };
      })()`
    );

    console.log(`目标：<${pos.tag}> ${pos.text ? `「${pos.text}」` : ""} @ (${pos.x},${pos.y})`);
    console.log(`命中：<${hit ? hit.tag : "?"}> ${hit ? hit.text : ""}`);

    if (DRY) {
      console.log("--dry：只定位，未点击");
      return;
    }

    await cdp.clickAt(send, pos.x, pos.y);
    console.log("已点击");
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
