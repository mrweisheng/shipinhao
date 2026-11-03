#!/usr/bin/env node
/**
 * 32-sync-skill.js — 同步两份 skill 副本，避免规则分叉
 *
 * 背景（2026-11-03）：
 *   `skills/channels-comment-ops/` 和 `.opencode/skills/channels-comment-ops/`
 *   是同一套规则的两份副本。2026-11-03 发现 SKILL.md 已经分叉 261 行，
 *   同一件事在两份文件里写法不同，模型读到哪份算哪份。
 *
 * 口径：**`.opencode/` 是唯一权威**（OpenCode 实际加载它），`skills/` 只做镜像。
 *
 * 用法：
 *   node scripts\32-sync-skill.js           # 把 .opencode 覆盖到 skills
 *   node scripts\32-sync-skill.js --check   # 只检查，不一致退出码 1
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, ".opencode", "skills", "channels-comment-ops");
const DST = path.join(ROOT, "skills", "channels-comment-ops");
const CHECK = process.argv.includes("--check");

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}

const srcFiles = walk(SRC).sort();
const dstFiles = fs.existsSync(DST) ? walk(DST).sort() : [];
const all = [...new Set([...srcFiles, ...dstFiles])].sort();

const diffs = [];
for (const rel of all) {
  const a = path.join(SRC, rel);
  const b = path.join(DST, rel);
  const hasA = fs.existsSync(a);
  const hasB = fs.existsSync(b);
  if (!hasA || !hasB) {
    diffs.push(`${rel}（${hasA ? "仅 .opencode" : "仅 skills"}）`);
    continue;
  }
  if (fs.readFileSync(a, "utf8") !== fs.readFileSync(b, "utf8")) diffs.push(rel);
}

if (CHECK) {
  if (diffs.length) {
    console.error("✗ skill 副本不一致：");
    diffs.forEach((d) => console.error("  - " + d));
    console.error("跑 node scripts\\32-sync-skill.js 同步");
    process.exit(1);
  }
  console.log("✓ skill 副本一致（" + all.length + " 个文件）");
  process.exit(0);
}

fs.mkdirSync(DST, { recursive: true });
for (const rel of srcFiles) {
  const a = path.join(SRC, rel);
  const b = path.join(DST, rel);
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.copyFileSync(a, b);
}
// 删掉 skills 里多出来的旧文件（.opencode 已不存在的）
for (const rel of dstFiles) {
  if (!srcFiles.includes(rel)) fs.rmSync(path.join(DST, rel), { force: true });
}
console.log("✓ 已同步 .opencode → skills（" + srcFiles.length + " 个文件）");
