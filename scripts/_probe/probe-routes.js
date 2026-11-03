#!/usr/bin/env node
/**
 * probe-routes.js — 记录「后台菜单 → 真实 URL」，供随机跳页测试使用
 *
 * 侧边栏当前版本只有图标、没有文字，所以这里不按可见文字找菜单，
 * 而是用 lib/nav.js：悬停图标 → 读弹窗标题 → 点弹窗里的子项。
 *
 * 产出：data/routes.json
 *   { when, total, results: [{ parent, child, ok, url, newTab, error }] }
 *
 * 用法：
 *   node scripts/probe-routes.js                       # 全部菜单
 *   node scripts/probe-routes.js --only 内容管理,互动管理
 *   node scripts/probe-routes.js --max 10              # 只测前 10 条，快速验证
 */

const fs = require("fs");
const path = require("path");
const cdp = require("./lib/cdp");
const nav = require("./lib/nav");
const login = require("./lib/login");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return d;
};

const ONLY = getArg("only", null);
const MAX = Number(getArg("max", "0")) || 0;
const OUT = getArg("json", "./data/routes.json");
const PORT = Number(getArg("port", "9222"));

const esc = (send) =>
  send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27,
  }).then(() =>
    send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27,
    })
  ).catch(() => {});

const ids = (tabs) => new Set(tabs.map((t) => t.id));

(async () => {
  const auth = await login.requireLogin({ port: PORT, wait: 300 });
  if (!auth.ok) process.exit(auth.code);

  const pages = await cdp.listPages(PORT);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  if (!page) throw new Error("不在视频号后台页面");
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);

  try {
    await cdp.ensureVisible(send);

    console.log("枚举侧边栏（悬停图标读弹窗标题）…");
    const menu = await nav.listMenu(send);
    const pairs = [];
    for (const m of menu) {
      if (!m.title || !m.children.length) continue;
      if (ONLY && !ONLY.split(",").map((s) => s.trim()).includes(m.title)) continue;
      for (const child of m.children) pairs.push({ parent: m.title, child });
    }
    const todo = MAX ? pairs.slice(0, MAX) : pairs;
    console.log(`共 ${pairs.length} 个入口，本次测试 ${todo.length} 个\n`);

    const results = [];
    for (const { parent, child } of todo) {
      await esc(send);
      await cdp.sleep(200);

      const before = await cdp.evaluate(send, "location.href");
      const beforeIds = ids(await cdp.listPages(PORT));

      let err = null;
      try {
        await nav.clickMenuPath(send, parent, child);
      } catch (e) {
        err = e.message;
      }

      let url = before;
      if (!err) {
        // 等 URL 变化，最多 5s；有些入口点完还是同一个 URL（如已在目标页）
        const deadline = Date.now() + 5000;
        for (;;) {
          await cdp.sleep(250);
          const now = await cdp.evaluate(send, "location.href").catch(() => before);
          if (now && now !== before) { url = now; break; }
          if (Date.now() > deadline) break;
        }
        await cdp.sleep(600);
        url = await cdp.evaluate(send, "location.href").catch(() => url);
      }

      // 记录是否弹出了新标签页，并关掉它，避免越开越多
      let newTab = null;
      const after = await cdp.listPages(PORT).catch(() => []);
      const fresh = after.filter((t) => t.type === "page" && !beforeIds.has(t.id));
      if (fresh.length) {
        newTab = fresh[0].url;
        for (const t of fresh) {
          await cdp.closeTarget(PORT, t.id);
        }
      }

      const ok = !err && !!url && url.includes("/platform");
      results.push({ parent, child, ok, url, newTab, error: err });
      console.log(`${ok ? "✓" : "✗"} ${parent} → ${child}`);
      console.log(`    ${url}${newTab ? `   [新标签页 ${newTab}]` : ""}${err ? `   ${err}` : ""}`);
    }

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(
      OUT,
      JSON.stringify({ when: new Date().toISOString(), total: results.length, results }, null, 2),
      "utf8"
    );
    console.log(`\n已保存：${OUT}`);

    // 回到评论管理页，方便接着做别的
    await esc(send);
    try {
      await nav.clickMenuPath(send, "互动管理", "评论");
      await cdp.sleep(1500);
      console.log(`已回到：${await cdp.evaluate(send, "location.href")}`);
    } catch (e) {
      console.log(`（返回评论页失败：${e.message}）`);
    }
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
