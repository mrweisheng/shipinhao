#!/usr/bin/env node
/**
 * 24-sweep-account.js — 把一个账号的全部视频捋一遍，写进新存储
 *
 * 键用「发布时间」，不用序号：序号会随新视频右移，发布时间不会。
 *
 * 用法：
 *   # 只建索引，不抓评论（几秒）
 *   node scripts/24-sweep-account.js --account mingge-yg --display 明哥揾粤港车 --index-only --list .\data\videos-1028-acct2.json
 *
 *   # 全量抓（很久，可断点续跑）
 *   node scripts/24-sweep-account.js --account mingge-yg --display 明哥揾粤港车 --from 1 --to 171
 *
 *   # 只抓没抓过的（lastCaptureAt 为空），用于续跑
 *   node scripts/24-sweep-account.js --account mingge-yg --display 明哥揾粤港车 --only-new
 *
 * 退出码：0 正常 / 1 有失败 / 3 账号不匹配或浏览器不可用
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const store = require("./lib/store");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return d;
};
const has = (n) => argv.includes(`--${n}`);

const ACCOUNT = getArg("account");
const DISPLAY = getArg("display");
if (!ACCOUNT) {
  console.error("需要 --account <id>（例如 mingge-yg）");
  process.exit(1);
}

store.ensureAccount({ id: ACCOUNT, displayName: DISPLAY || "" });
const tmpDir = path.join(__dirname, "..", "data", "_sweep");
fs.mkdirSync(tmpDir, { recursive: true });

// ── 只建索引 ────────────────────────────────────────────
if (has("index-only")) {
  const listFile = getArg("list");
  if (!listFile) {
    console.error("--index-only 需要 --list <videos-*.json>");
    process.exit(1);
  }
  const v = JSON.parse(fs.readFileSync(listFile, "utf8"));
  let n = 0;
  for (const f of v.feeds || []) {
    if (store.upsertFromList(ACCOUNT, f)) n++;
  }
  const rows = store.readVideos(ACCOUNT);
  console.log(`索引完成：写入 ${n} 条，索引现有 ${rows.length} 条`);
  console.log(`目录：${store.accDir(ACCOUNT)}`);
  const missing = rows.filter((r) => !r.publishTime);
  if (missing.length) console.log(`⚠ ${missing.length} 条缺发布时间键`);
  process.exit(0);
}

// ── 全量抓取 ────────────────────────────────────────────
const FROM = Number(getArg("from", "1"));
const TO = Number(getArg("to", "99999"));
const ONLY_NEW = has("only-new");
const FORCE = has("force");

function currentAccountName() {
  const r = spawnSync(process.execPath, [path.join(__dirname, "26-whoami.js")], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0) return "";
  return String(r.stdout || "").trim();
}

if (DISPLAY) {
  const got = currentAccountName();
  if (got && !got.includes(DISPLAY)) {
    console.error(`[失败] 当前登录账号是「${got}」，与要求的「${DISPLAY}」不一致。`);
    console.error("      为避免串号，已中止。请先切换到正确账号。");
    process.exit(3);
  }
  console.log(`✓ 账号校验通过：${DISPLAY}`);
}

const todo = [];
const rows = store.readVideos(ACCOUNT);
const byPt = new Map(rows.map((r) => [r.publishTime, r]));
for (let i = FROM; i <= TO; i++) {
  if (ONLY_NEW) {
    // 只有「已知视频且没抓过」才抓。序号当天可能位移，所以按现有索引的先后顺序走。
    if (i > rows.length) break;
  }
  todo.push(i);
}

console.log(`\n开始扫描：nth ${FROM} → ${Math.min(TO, ONLY_NEW ? rows.length : TO)}，共 ${todo.length} 个位置\n`);

let ok = 0;
let fail = 0;
let skip = 0;
const t0 = Date.now();

for (const nth of todo) {
  // 同一时刻只有一个账号在线：每 10 条复核一次，切号了立刻停
  if (DISPLAY && ok > 0 && ok % 10 === 0) {
    const who = currentAccountName();
    if (who && !who.includes(DISPLAY)) {
      console.error(`\n[中止] 第 ${nth} 条前发现账号已切换为「${who}」，与「${DISPLAY}」不一致。`);
      console.error("      为避免把数据写进错的账号目录，这里直接停。已完成的部分保留。");
      process.exitCode = 3;
      break;
    }
  }
  const tmp = path.join(tmpDir, `nth${nth}.json`);
  const r = spawnSync(process.execPath, [path.join(__dirname, "07-read-video.js"), "--nth", String(nth), "--json", tmp, "--wait", "120"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!fs.existsSync(tmp)) {
    fail++;
    console.log(`[${nth}] ✗ 读取失败（退出码 ${r.status}）`);
    continue;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(tmp, "utf8"));
  } catch {
    fail++;
    console.log(`[${nth}] ✗ JSON 解析失败`);
    continue;
  }
  const pt = store.publishKey(data.video);
  if (ONLY_NEW && pt && byPt.get(pt) && byPt.get(pt).lastCaptureAt && !FORCE) {
    skip++;
    console.log(`[${nth}] 跳过（已抓过 ${pt}）`);
    continue;
  }
  const res = store.ingestCapture(ACCOUNT, data);
  if (!res.ok) {
    fail++;
    console.log(`[${nth}] ✗ ${res.reason}`);
    continue;
  }
  ok++;
  console.log(
    `[${nth}] ✓ ${res.publishTime}  ${res.isNew ? "新增" : "更新"}  声明 ${res.commentCount}  待回 ${res.awaiting}  ${String((data.video || {}).title || "").split("#")[0].slice(0, 26)}`
  );
  fs.unlinkSync(tmp);
}

const mins = ((Date.now() - t0) / 60000).toFixed(1);
const after = store.readVideos(ACCOUNT);
console.log(`\n完成：成功 ${ok}｜失败 ${fail}｜跳过 ${skip}｜用时 ${mins} 分钟`);
console.log(`索引现有 ${after.length} 条，目录 ${store.accDir(ACCOUNT)}`);
process.exitCode = fail ? 1 : 0;
