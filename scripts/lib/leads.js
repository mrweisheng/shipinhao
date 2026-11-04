#!/usr/bin/env node
/**
 * lib/leads.js — 重点线索记录（问联系方式 / 问价格）
 *
 * 为什么单独记：
 *   评论区只能给公开信息，问联系方式、问价格这两类要老板私下人工跟进。
 *   每批维护完自动落一条记录，人工照 leads.html 处理即可，不用翻聊天记录。
 *
 * 数据：
 *   data/leads/leads.jsonl   一行一条，追加、去重（key）
 *   data/leads/leads.html    给人看的静态页，每次重算生成（无外链、无脚本）
 *
 * 线索从哪来：
 *   plan 里 action=reply 且 lead="contact"|"price" 的条目；
 *   只有发送成功（result=ok）才记，试运行/失败/跳过不记。
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const DIR = process.env.LEADS_DIR || path.join(ROOT, "data", "leads");
const JSONL = path.join(DIR, "leads.jsonl");
const HTML = path.join(DIR, "leads.html");

const TYPE_LABEL = { contact: "问联系方式", price: "问价格" };
const TYPE_ORDER = ["contact", "price"];

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function readAll() {
  try {
    return fs
      .readFileSync(JSONL, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function videoNth(plan) {
  if (plan && plan.nth != null && plan.nth !== "") return Number(plan.nth);
  const src = String((plan && (plan.source || plan.planFile)) || "");
  const m = src.match(/nth(\d+)/i) || src.match(/plan-nth(\d+)/i);
  return m ? Number(m[1]) : null;
}

function leadType(x) {
  const v = String((x && x.lead) || "").toLowerCase();
  if (v === "contact" || v === "price") return v;
  return null;
}

/** 从「已发送结果 + plan」里抽重点线索；返回新增条数 */
function recordResults({ resultFile, plan }) {
  if (!resultFile || !plan) return 0;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  } catch {
    return 0;
  }
  if (data.mode !== "send") return 0;

  const results = Array.isArray(data.results) ? data.results : [];
  const nth = videoNth(plan);
  const video = plan.video || data.video || {};
  const existing = new Set(readAll().map((r) => r.key));
  const rows = [];

  for (const r of results) {
    if (r.result !== "sent" && r.result !== "ok") continue;
    const type = leadType(r);
    if (!type) continue;
    const key = [
      video.time || "",
      video.title || "",
      r.index,
      r.name || "",
      r.time || "",
      r.text || "",
    ].join("|");
    if (existing.has(key)) continue;
    existing.add(key);
    rows.push({
      key,
      type,
      recordedAt: new Date().toISOString(),
      videoNth: nth,
      videoTitle: video.title || "",
      videoTime: video.time || "",
      commentIndex: r.index,
      commentName: r.name || "",
      commentTime: r.time || "",
      commentContent: r.content || "",
      replyText: r.text || "",
      asked: r.asked || "",
      category: r.category || "",
    });
  }

  if (!rows.length) return 0;
  ensureDir(JSONL);
  fs.appendFileSync(JSONL, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return rows.length;
}

/** 从 plan 直接补录（计划里的 reply 默认按已发送处理；用于补历史批次） */
function recordPlan(planFile) {
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  } catch {
    return 0;
  }
  const items = (plan.items || [])
    .filter((x) => x.action === "reply" && leadType(x))
    .map((x) => ({ ...x, result: "ok" }));
  return recordRowsFromItems(plan, items);
}

function recordRowsFromItems(plan, items) {
  const nth = videoNth(plan);
  const video = plan.video || {};
  const existing = new Set(readAll().map((r) => r.key));
  const rows = [];
  for (const r of items) {
    const type = leadType(r);
    if (!type) continue;
    const key = [video.time || "", video.title || "", r.index, r.name || "", r.time || "", r.text || ""].join("|");
    if (existing.has(key)) continue;
    existing.add(key);
    rows.push({
      key,
      type,
      recordedAt: new Date().toISOString(),
      videoNth: nth,
      videoTitle: video.title || "",
      videoTime: video.time || "",
      commentIndex: r.index,
      commentName: r.name || "",
      commentTime: r.time || "",
      commentContent: r.content || "",
      replyText: r.text || "",
      asked: r.asked || "",
      category: r.category || "",
    });
  }
  if (!rows.length) return 0;
  ensureDir(JSONL);
  fs.appendFileSync(JSONL, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return rows.length;
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tableRows(rows) {
  return rows
    .map((r, i) => {
      const nth = r.videoNth ? `#${r.videoNth}` : "—";
      return `<tr>
  <td class="idx">${i + 1}</td>
  <td class="video"><span class="nth">${esc(nth)}</span><div class="title">${esc(r.videoTitle)}</div></td>
  <td class="time">${esc(r.videoTime)}</td>
  <td class="commenter"><div class="name">${esc(r.commentName)}</div><div class="time">评论 #${esc(r.commentIndex)} · ${esc(r.commentTime)}</div></td>
  <td class="content">${esc(r.commentContent)}</td>
  <td class="reply">${esc(r.replyText)}</td>
  <td class="time small">${esc((r.recordedAt || "").slice(0, 10))}</td>
</tr>`;
    })
    .join("\n");
}

function section(type, rows) {
  const label = TYPE_LABEL[type] || type;
  if (!rows.length) {
    return `<section>
  <h2>${esc(label)} <span class="count">0</span></h2>
  <div class="empty">暂无记录</div>
</section>`;
  }
  return `<section>
  <h2>${esc(label)} <span class="count">${rows.length}</span></h2>
  <table>
    <thead><tr><th>#</th><th>视频</th><th>发布时间</th><th>评论者</th><th>评论内容</th><th>我们的回复</th><th>记录日</th></tr></thead>
    <tbody>
${tableRows(rows)}
    </tbody>
  </table>
</section>`;
}

function render() {
  const all = readAll();
  const byType = { contact: [], price: [] };
  for (const r of all) {
    if (byType[r.type]) byType[r.type].push(r);
  }
  // 新视频在前；同一视频按评论序号
  const sortKey = (r) => `${r.videoTime || ""}|${String(r.videoNth || "").padStart(4, "0")}|${String(r.commentIndex || 0).padStart(6, "0")}`;
  for (const k of TYPE_ORDER) byType[k].sort((a, b) => sortKey(b).localeCompare(sortKey(a)));

  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>重点线索 · 问联系方式 / 问价格</title>
<style>
  :root{--bg:#f5f6f8;--card:#fff;--line:#e5e7eb;--text:#111827;--muted:#6b7280;--contact:#0f766e;--price:#b45309}
  *{box-sizing:border-box}
  body{margin:0;padding:28px 20px 48px;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.55}
  header,section{max-width:1240px;margin:0 auto}
  h1{font-size:21px;margin:0 0 6px}
  .meta{color:var(--muted);font-size:12.5px}
  .cards{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0 24px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 18px;min-width:140px}
  .card span{color:var(--muted);font-size:12.5px}
  .card b{display:block;font-size:26px;margin-top:2px}
  .card.contact b{color:var(--contact)}
  .card.price b{color:var(--price)}
  section{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-bottom:26px}
  h2{font-size:15px;margin:0;padding:13px 18px;border-bottom:1px solid var(--line);background:#fafafa}
  .count{color:var(--muted);font-weight:400;margin-left:4px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
  th{background:#fbfbfc;color:#374151;font-weight:600;white-space:nowrap}
  tbody tr:nth-child(even){background:#fcfcfd}
  tbody tr:last-child td{border-bottom:none}
  .idx{color:var(--muted);white-space:nowrap}
  .nth{display:inline-block;background:#eef2ff;color:#3730a3;border-radius:6px;padding:1px 7px;font-size:12px;margin-bottom:4px}
  .video .title{max-width:300px}
  .commenter .name{font-weight:700;font-size:14px}
  .content{max-width:300px;white-space:pre-wrap}
  .reply{color:var(--contact);max-width:240px;white-space:pre-wrap}
  .time{color:var(--muted);font-size:12px;white-space:nowrap}
  .small{font-size:11.5px}
  .empty{padding:22px 18px;color:var(--muted)}
  @media print{body{background:#fff;padding:0}section{border:none;break-inside:avoid}h2{background:#fff}}
</style>
</head>
<body>
<header>
  <h1>重点线索 · 问联系方式 / 问价格</h1>
  <div class="meta">生成时间：${esc(stamp)}　｜　累计 ${all.length} 条　｜　数据文件：data/leads/leads.jsonl</div>
  <div class="cards">
    <div class="card"><span>累计</span><b>${all.length}</b></div>
    <div class="card contact"><span>问联系方式</span><b>${byType.contact.length}</b></div>
    <div class="card price"><span>问价格</span><b>${byType.price.length}</b></div>
  </div>
</header>
${section("contact", byType.contact)}
${section("price", byType.price)}
</body>
</html>
`;

  ensureDir(HTML);
  fs.writeFileSync(HTML, html, "utf8");
  return HTML;
}

module.exports = { recordResults, recordPlan, render, readAll, DIR, JSONL, HTML };
