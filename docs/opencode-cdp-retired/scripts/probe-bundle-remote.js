#!/usr/bin/env node
/**
 * probe-bundle-remote.js — 下载互动管理页的前端 JS，在源码里找「展开更多回复」的触发逻辑
 *
 * 用 Node 直接抓 res.wx.qq.com 上的 chunk（不需要登录态），
 * grep "downContinueFlag" / "load-more__btn" / "展开更多回复"，
 * 打印命中位置附近的代码。
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const BASE = "https://res.wx.qq.com/t/wx_fed/finder/helper/finder-helper-interaction/res/static/js/";
const FILES = [
  "index.f6549fa6.js",
  "chunk-common.bfa9ed7b.js",
  "async/chunk-dynamic.594ba5b8.js",
  "async/chunk-pc.ac7988bb.js",
  "async/62.b598f6b5.js",
  "async/830.0988402c.js",
  "async/831.2ea74990.js",
  "async/512.bb05e9f7.js",
  "async/722.085115a2.js",
  "async/251.9a7999b0.js",
  "async/412.d9a15628.js",
  "async/299.ad41ec24.js",
  "async/894.f7b881b2.js",
];

const get = (url) =>
  new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) return reject(new Error(res.statusCode + " " + url));
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      })
      .on("error", reject);
  });

const KEYS = ["load-more__btn", "downContinueFlag", "展开更多回复", "levelTwoComment"];

(async () => {
  const dir = path.join(__dirname, "..", "data", "probe", "js");
  fs.mkdirSync(dir, { recursive: true });

  for (const f of FILES) {
    let text;
    try {
      text = await get(BASE + f);
    } catch (e) {
      console.log(`✗ ${f}  ${e.message}`);
      continue;
    }
    const out = path.join(dir, f.replace(/\//g, "_"));
    fs.writeFileSync(out, text, "utf8");

    const hits = [];
    for (const k of KEYS) {
      let i = -1;
      let n = 0;
      while ((i = text.indexOf(k, i + 1)) >= 0 && n < 3) {
        hits.push({ k, i });
        n++;
      }
    }
    if (!hits.length) {
      console.log(`- ${f}  ${text.length} 字符，无关键词`);
      continue;
    }
    console.log(`\n===== ${f}  ${text.length} 字符，命中 ${hits.length} 处 =====`);
    for (const h of hits) {
      const s = Math.max(0, h.i - 300);
      console.log(`\n--- ${h.k} @${h.i} ---`);
      console.log(text.slice(s, h.i + 300).replace(/\s+/g, " "));
    }
  }
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
