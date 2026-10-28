#!/usr/bin/env node
/**
 * probe-layout.js — 页面结构自检（改版后第一时间跑这个）
 *
 * 逐条检查「判断依据」是否还在：
 *   列表项 / 总数 / 视频tab / 详情头 / 评论项 / 折叠按钮 / 侧边栏
 * 缺失时会输出同区域的候选元素（按 class 关键词打分），
 * 方便判断新版该用哪个选择器，并更新 lib/layout-map.js。
 *
 * 用法：
 *   node scripts/probe-layout.js
 *   node scripts/probe-layout.js --json .\data\layout-report.json
 */

const fs = require("fs");
const path = require("path");
const cdp = require("./lib/cdp");
const layout = require("./lib/layout-map");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return d;
};
const OUT = getArg("json", null);
const PORT = Number(getArg("port", 9222));

(async () => {
  const pages = await cdp.listPages(PORT);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  if (!page) throw new Error("不在视频号后台页面");
  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);

  try {
    const raw = await layout.check(send);
    // 有详情头 = 已经打开了某个视频，评论区相关项应当存在
    const context = !!(raw && raw.items.detailHeader && raw.items.detailHeader.count > 0);
    const s = layout.print(raw, { context });

    if (OUT) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(
        OUT,
        JSON.stringify({ when: new Date().toISOString(), context, ok: s.ok, result: s, raw }, null, 2),
        "utf8"
      );
      console.log(`\n已保存：${OUT}`);
    }

    process.exit(s.ok ? 0 : 1);
  } finally {
    close();
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
