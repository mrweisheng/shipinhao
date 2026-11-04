#!/usr/bin/env node
/**
 * 33-lead-report.js — 重点线索（问联系方式 / 问价格）记录与 HTML 报告
 *
 * 用途：
 *   每批策略执行/维护完，把「问联系方式」「问价格」的评论单独记下来，
 *   生成 data/leads/leads.html，人工私下跟进。不生成外链、不引平台动作。
 *
 * 用法：
 *   node scripts\33-lead-report.js --result .\data\reply\result-plan-nth5-xxx.json
 *       # 从发送结果补记（只记 result=ok 且 plan 里 lead 有值的条目）
 *
 *   node scripts\33-lead-report.js --plan .\data\reply\plan-nth5.json
 *       # 从计划直接补记（按已发送处理；用于补历史批次）
 *
 *   node scripts\33-lead-report.js --render
 *       # 只重算 HTML
 *
 *   node scripts\33-lead-report.js
 *       # 不给参数 = 只重算 HTML
 *
 * 说明：
 *   - 记录键 = 视频时间 + 标题 + 评论序号 + 昵称 + 评论时间 + 回复正文，重复执行不会重复记。
 *   - 只有 plan 里标了 "lead": "contact" / "price" 的回复才记。
 */

const fs = require("fs");
const path = require("path");
const leads = require("./lib/leads");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return d;
};

const RESULT = getArg("result");
const PLAN = getArg("plan");
const RENDER_ONLY = argv.includes("--render") || (!RESULT && !PLAN);

let added = 0;

if (RESULT) {
  const file = path.resolve(RESULT);
  if (!fs.existsSync(file)) {
    console.error(`找不到结果文件：${file}`);
    process.exit(2);
  }
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const planFile = data.planFile ? path.resolve(data.planFile) : null;
  if (!planFile || !fs.existsSync(planFile)) {
    console.error("结果文件里没有可用的 planFile，无法取视频信息。改用 --plan 补录。");
    process.exit(2);
  }
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  added = leads.recordResults({ resultFile: file, plan });
}

if (PLAN) {
  const file = path.resolve(PLAN);
  if (!fs.existsSync(file)) {
    console.error(`找不到计划文件：${file}`);
    process.exit(2);
  }
  added += leads.recordPlan(file);
}

const html = leads.render();
const all = leads.readAll();
const contact = all.filter((r) => r.type === "contact").length;
const price = all.filter((r) => r.type === "price").length;

console.log(`重点线索：新增 ${added} 条｜累计 ${all.length} 条（联系方式 ${contact} / 价格 ${price}）`);
console.log(`报告：${html}`);
