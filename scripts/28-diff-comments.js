#!/usr/bin/env node
/**
 * 28-diff-comments.js — 评论区增量检测（纯数据对比，不碰浏览器）
 *
 * 设计依据（2026-10-29 doubao-port 实测）：
 *  - 评论 DOM 没有唯一 ID（无 data-comment-id）。
 *  - (昵称 + 时间) 不可靠：同一用户可改昵称（实测「宐妍」→「用户溢莹」、
 *    「小幸運(無言)願家安康」→「小幸運(無言)身體健」），改后旧评论会被误判为新增。
 *  - (时间 + 内容) 稳定：发布时间与内容除非删除否则不可变；二级回复「回复XX:」
 *    前缀里的昵称变化会造成误报，但用「时间晚于本地快照最新时间」过滤即可消除。
 *  - 因此增量判定 = 浏览器评论 time > 本地 latest.json 的 max(time)。
 *
 * 用法：
 *   node scripts\28-diff-comments.js --local data\accounts\mingge-jg\v\20261017-0700\latest.json --scan browser-scan.json
 *   --local 必填：本地快照（latest.json，含 comments[].time）
 *   --scan  必填：浏览器扫描导出（{items:[{level,name,time,isAuthor,text}]}）
 *   输出：本地 maxTime、按时间新增清单（含作者回复标注）、指纹级提示
 */
const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const localPath = arg('local');
const scanPath = arg('scan');
if (!localPath || !scanPath) {
  console.error('用法: node scripts\\28-diff-comments.js --local <latest.json> --scan <scan.json>');
  process.exit(1);
}

const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
const scan = JSON.parse(fs.readFileSync(scanPath, 'utf8'));

// 规范化：去 [[X]] / [X] / [/:X] 表情标记 + 去全部空白
function norm(s) {
  let t = String(s || '');
  t = t.replace(/\[\[[^\[\]]*\]\]/g, '');
  t = t.replace(/\[[^\[\]]*\]/g, '');
  return t.replace(/\s+/g, '');
}

const localComments = local.comments || [];
let maxTime = '0000/00/00 00:00';
for (const c of localComments) {
  if (c.time && c.time > maxTime) maxTime = c.time;
}
const localKeys = new Set(localComments.map(c => c.time + '\u0000' + norm(c.content)));

const items = (scan.items || scan.comments || []);
const byTime = items.filter(i => i.time > maxTime);
const byFingerprint = items.filter(i => !localKeys.has(i.time + '\u0000' + norm(i.text || i.content)));

console.log(`本地快照: ${localComments.length} 条 | 最新评论时间: ${maxTime}`);
console.log(`浏览器扫描: ${items.length} 条`);
console.log(`\n=== 按时间新增（time > ${maxTime}）: ${byTime.length} 条 ===`);
for (const i of byTime) {
  console.log(`  L${i.level} ${i.time} | ${(i.name || '').slice(0, 12)} | ${i.isAuthor ? '[作者] ' : ''}${(i.text || i.content || '').slice(0, 50)}`);
}
console.log(`\n=== 指纹级提示（time <= maxTime 但本地无该指纹，通常为昵称变化/格式差异，可跳过）: ${byFingerprint.length} 条 ===`);
console.log('（此类不参与判定：时间不晚于快照即已扫描过，最多因昵称变化重判一次）');
