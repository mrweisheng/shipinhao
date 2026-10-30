#!/usr/bin/env node
/**
 * 13-execute-plan.js — 执行「模型填好的计划」（唯一的发送入口）
 *
 * 分工：模型负责理解评论、决定回不回、写什么；本脚本只负责安全校验与执行。
 * 脚本里没有任何业务关键词，换账号/换业务/换说法都不用改。
 *
 * 用法：
 *   node scripts/13-execute-plan.js --plan .\data\reply\plan-nth6.json            # 只校验，不发
 *   node scripts/13-execute-plan.js --plan .\data\reply\plan-nth6.json --rehearse  # 逐条试运行（不发送）
 *   node scripts/13-execute-plan.js --plan .\data\reply\plan-nth6.json --send      # 正式发送
 *
 * 发送间隔默认 3–8 秒；遇到服务端拒绝（08 退出码 5）立即停止本批，避免继续触发风控。
 * 退出码：0 全部按计划完成 / 1 有失败或被拒 / 4 计划校验不通过
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const cdp = require("./lib/cdp");
const store = require("./lib/store");
const planLib = require("./lib/plan");
const caseLib = require("./lib/case-library");
const { appendHistory } = require("./lib/template-pool");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return d;
};
const has = (n) => argv.includes(`--${n}`);

const PLAN_FILE = getArg("plan", null);
const ACCOUNT = getArg("account", null); // 可选：发送前校验当前登录账号
const SEND = has("send");
const REHEARSE = has("rehearse");
const LIKE = !has("no-like");
const LIMIT = Number(getArg("limit", "0"));
const MAX_FAIL = Number(getArg("max-fail", "3"));
const MIN_GAP = Number(getArg("min-gap", "3000"));
const MAX_GAP = Number(getArg("max-gap", "8000"));
const NTH = getArg("nth", null);
const JSON_OUT = getArg("json", null);
const STRICT_DUP = has("strict-dup");
const NO_VERIFY = has("no-verify");

const here = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const tail = (s, n = 4) => String(s || "").trim().split(/\r?\n/).slice(-n).join("\n");
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

function ensureDir(p) {
  const d = path.dirname(p);
  if (d && !fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const runNode = (script, args) =>
  spawnSync(process.execPath, [path.join(here, script), ...args], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });

/** 当前登录账号 → data/accounts 的目录 id（state 落库用） */
function currentAccountId(explicit) {
  if (explicit) return explicit;
  const r = runNode("26-whoami.js", []);
  const name = String(r.stdout || "").trim();
  return name ? store.findAccountByName(name) : null;
}

/** 把已决条目写回 state.jsonl：skip 与 reply 都算「已处理」，25-open-items 不再报待回 */
function persistDecision(plan, accId, items, action) {
  if (!accId || !items || !items.length) return 0;
  const pt = plan.video && store.publishKey({ time: plan.video.time });
  if (!pt) {
    console.warn("[提示] 计划缺少视频发布时间，state 未落库");
    return 0;
  }
  const at = new Date().toISOString();
  const source = path.basename(PLAN_FILE);
  const rows = items.map((x) => ({
    fp: store.commentFp({ author: x.name, time: x.time }),
    author: x.name,
    time: x.time,
    action,
    text: action === "reply" ? x.text : "",
    reason: x.reason || "",
    source,
    at,
  }));
  store.appendState(accId, pt, rows);
  return rows.length;
}

/** 当前页面必须是计划里那条视频，且评论区已就绪 */
async function preflight(plan) {
  const pages = await cdp.listPages(9222);
  const page = pages.find((p) => p.type === "page" && p.url.includes("interaction/comment"));
  if (!page) throw new Error("当前不在评论管理页，先跑 node scripts\\07-read-video.js --nth N");

  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);
  try {
    const st = await cdp.evaluate(send, `(() => {
      const root = document.querySelector("wujie-app")?.shadowRoot;
      if (!root) return null;
      const sel = root.querySelector(".feed-selected-info");
      const tips = root.querySelector(".comment-count__tips");
      const m = tips ? (tips.innerText || "").match(/(\\d+)\\s*条/) : null;
      const t = sel && sel.querySelector(".feed-title");
      const tm = sel && sel.querySelector(".feed-time");
      return {
        title: t ? (t.innerText || "").replace(/\\s+/g, " ").trim() : null,
        time: tm ? (tm.innerText || "").replace(/\\s+/g, " ").trim() : null,
        declared: m ? Number(m[1]) : null,
        comments: root.querySelectorAll(".comment-item").length,
      };
    })()`);
    if (!st) throw new Error("评论区还没渲染出来，先重新打开视频");
    if (!st.comments) throw new Error("当前视频的评论区没有渲染，先跑 07 打开目标视频");

    const want = norm(plan.video && plan.video.title);
    const got = norm(st.title);
    if (want && got && !got.includes(want.slice(0, 20)) && !want.includes(got.slice(0, 20))) {
      throw new Error(`当前页面不是计划里的视频：\n  计划：${want.slice(0, 50)}\n  当前：${got.slice(0, 50)}\n先重新打开目标视频`);
    }
    return st;
  } finally {
    close();
  }
}

async function cleanupPanels() {
  try {
    const pages = await cdp.listPages(9222);
    const page = pages.find((p) => p.type === "page" && p.url.includes("interaction/comment"));
    if (!page) return 0;
    const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);
    try {
      return await cdp.evaluate(send, `(() => {
        const root = document.querySelector("wujie-app")?.shadowRoot;
        if (!root) return 0;
        let n = 0;
        for (const ta of root.querySelectorAll("textarea.create-input")) {
          const item = ta.closest(".comment-item");
          const btn = item && [...item.querySelectorAll(".create-ft .tag-wrap")]
            .find((b) => (b.innerText || "").trim() === "取消");
          if (btn) { btn.click(); n++; }
        }
        return n;
      })()`);
    } finally {
      close();
    }
  } catch {
    return 0;
  }
}

function printPlan(plan) {
  const replies = plan.items.filter((x) => x.action === "reply");
  const skips = plan.items.filter((x) => x.action === "skip");
  console.log(`\n视频：${(plan.video && plan.video.title) || "（未标注）"}`);
  console.log(`时间：${(plan.video && plan.video.time) || "?"}｜计划内 ${plan.items.length} 条：回复 ${replies.length}｜跳过 ${skips.length}`);

  for (const x of plan.items) {
    const mark = x.action === "reply" ? "回" : "跳";
    console.log(`\n[${mark}] #${x.index} ${x.name}${x.category ? `｜${x.category}` : ""}`);
    console.log(`     评论：${norm(x.content).slice(0, 60)}`);
    if (x.asked) console.log(`     在问：${x.asked}`);
    if (x.action === "reply") console.log(`     回复：${x.text}`);
    if (x.reason) console.log(`     理由：${x.reason}`);
  }
}

async function main() {
  if (!PLAN_FILE) {
    console.error("需要 --plan <计划 json>");
    process.exitCode = 1;
    return;
  }

  const plan = planLib.load(PLAN_FILE);
  const history = readHistorySafe();
  // 批次密度按「滚动 7 天」算（含 history）；单批 <5 条且历史不足时只查连续路径
  const v = planLib.validatePlan(plan, { history });
  const dup = planLib.checkDuplicates(plan, history);
  // 与最近 3 条完全相同 → 默认阻断；7 天内用过同一句 → 默认提醒，--strict-dup 时升级为阻断
  const dupErrors = STRICT_DUP ? [...dup.errors, ...dup.warnings] : dup.errors;
  const allErrors = [...v.errors, ...dupErrors];

  printPlan(plan);

  if (dup.warnings.length) {
    console.log("\n⚠ 文案重复提醒：");
    for (const w of dup.warnings) console.log("   - " + w);
  }
  if (v.warnings.length) {
    console.log("\n⚠ 计划提醒：");
    for (const w of v.warnings) console.log("   - " + w);
  }
  if (allErrors.length) {
    console.error("\n✗ 计划校验不通过：");
    for (const e of allErrors) console.error("   - " + e);
    process.exitCode = 4;
    return;
  }
  console.log("\n✓ 计划校验通过（禁词 / 长度 / 表情 / 引导数 / 重复）");

  const replies = plan.items.filter((x) => x.action === "reply");
  if (!SEND && !REHEARSE) {
    console.log("\n（未加 --send / --rehearse，只校验，不动页面。）");
    return;
  }

  // 同一时刻只可能有一个账号在线。切号后页面会变，但脚本不知道——
  // 发送前先确认「现在是谁」，避免把回复发到另一个号的客户身上，也避免 state 写错目录。
  let accId = ACCOUNT || null;
  if (ACCOUNT) {
    const acc = store.readAccount(ACCOUNT);
    if (!acc) {
      console.error(`[失败] 账号 ${ACCOUNT} 未注册（缺 data/accounts/${ACCOUNT}/account.json）`);
      process.exitCode = 3;
      return;
    }
    const r = runNode("26-whoami.js", ["--expect", acc.displayName || ""]);
    if (r.status !== 0) {
      console.error(`[失败] 当前登录账号不是「${acc.displayName}」，已中止发送。`);
      process.exitCode = 3;
      return;
    }
    console.log(`✓ 账号校验通过：${acc.displayName}`);
  } else {
    accId = currentAccountId(null);
    if (!accId) console.warn("[提示] 未识别当前账号，本次不写 state（不影响发送）；建议加 --account");
  }

  // 跳过项也落库：否则 25-open-items 下次还会把它们当待处理
  if (!REHEARSE) {
    const n = persistDecision(plan, accId, plan.items.filter((x) => x.action === "skip"), "skip");
    if (n) console.log(`✓ 已记录 ${n} 条跳过到 state`);
  }

  if (!replies.length) {
    console.log("\n没有需要回复的条目。");
    return;
  }

  const st0 = await preflight(plan);
  console.log(`\n当前页面：${st0.title}`);
  console.log(`评论计数：${st0.declared}`);

  let expected = Number(st0.declared) || Number(plan.declared) || null;
  if (plan.declared && st0.declared && Number(plan.declared) !== Number(st0.declared)) {
    console.log(`⚠ 计划里的计数是 ${plan.declared}，页面现在是 ${st0.declared}（可能有新评论，按页面为准）`);
  }

  const list = LIMIT > 0 ? replies.slice(0, LIMIT) : replies;
  if (LIMIT > 0 && replies.length > LIMIT) {
    console.log(`⚠ 只执行前 ${LIMIT} 条（共 ${replies.length} 条要回）`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let ok = 0;
  let failed = 0;
  let policy = 0;
  let rejected = 0;
  let stopBatch = false;
  let consecutiveFail = 0;
  const results = [];

  for (const x of list) {
    if (stopBatch) break;
    if (consecutiveFail >= MAX_FAIL) {
      console.log(`\n✗ 连续失败 ${consecutiveFail} 条，停止本轮（已完成的保留，可续跑）。`);
      break;
    }

    const kw = x.kw || planLib.keywordOf(x.content);
    console.log(`\n── #${x.index} ${x.name} → ${x.text}`);

    await cleanupPanels();

    const args = ["--name", x.name, "--kw", kw, "--text", x.text];
    if (LIKE) args.push("--like");
    if (REHEARSE) args.push("--dry");
    else if (expected !== null) args.push("--expect", String(expected));

    const itemFile = path.join(here, "..", "data", "reply",
      `${REHEARSE ? "rehearse" : "sent"}-${stamp}-${String(x.index).padStart(3, "0")}.json`);
    ensureDir(itemFile);
    args.push("--json", itemFile);

    let r = runNode("08-reply-comment.js", args);
    let out = `${r.stdout || ""}${r.stderr || ""}`;

    // 计数漂移（期间来了新评论）：08 在发送前中止，去掉 --expect 重试一次不会重复发
    if (!REHEARSE && r.status === 1 && /评论计数不是预期/.test(out)) {
      console.log("   ↻ 计数有变动，去掉 --expect 重试一次…");
      const retry = args.filter((a, i) => a !== "--expect" && args[i - 1] !== "--expect");
      r = runNode("08-reply-comment.js", retry);
      out = `${r.stdout || ""}${r.stderr || ""}`;
    }

    process.stdout.write(out.split(/\r?\n/).map((l) => (l ? "   " + l : l)).join("\n") + "\n");

    if (r.status === 0) {
      ok++;
      consecutiveFail = 0;
      if (!REHEARSE) {
        if (expected !== null) expected++;
        persistDecision(plan, accId, [x], "reply");
        appendHistory({
          text: x.text,
          category: x.category || null,
          name: x.name,
          at: new Date().toISOString(),
          video: (plan.video && plan.video.title) || null,
          videoTime: (plan.video && plan.video.time) || null,
          plan: path.basename(PLAN_FILE),
        });
        try {
          const caseRow = caseLib.add({
            comment: x.content || "",
            reply: x.text,
            intent: x.category || "unknown",
            business: (plan.titleContext && plan.titleContext.business) || "any",
            label: "unreviewed",
            note: `auto: sent｜asked=${x.asked || ""}`,
            source: path.basename(PLAN_FILE),
          });
          x.caseId = caseRow.id;
          console.log(
            `   案例：${caseRow.id}${caseRow.skipped ? "（已存在，跳过）" : caseRow.novel ? "（新场景，已入待确认队列）" : ""}`
          );
        } catch (e) {
          console.log(`   案例入库失败（不影响发送）：${e.message}`);
        }
      }
      results.push({ ...x, result: REHEARSE ? "rehearsed" : "sent" });
    } else if (r.status === 4) {
      if (/被拒|计数未\s*\+1|发送被拒/.test(out)) {
        rejected++;
        stopBatch = true;
        results.push({ ...x, result: "rejected", detail: tail(out, 4) });
        console.log("\n✗ 遇到服务端拒绝，停止本批（避免继续触发风控）。");
      } else {
        policy++;
        consecutiveFail = 0;
        results.push({ ...x, result: "policy-skip", detail: tail(out, 2) });
      }
    } else if (r.status === 5) {
      rejected++;
      stopBatch = true;
      results.push({ ...x, result: "rejected", detail: tail(out, 5) });
      console.log("\n✗ 服务端拒绝（见 trace），停止本批（避免继续触发风控）。");
    } else {
      failed++;
      consecutiveFail++;
      results.push({ ...x, result: "failed", detail: tail(out, 3) });
    }

    if (x !== list[list.length - 1]) await sleep(rand(MIN_GAP, MAX_GAP));
  }

  console.log(`\n结果：成功 ${ok}｜失败 ${failed}｜服务端拒绝 ${rejected}｜策略跳过 ${policy}${REHEARSE ? "（试运行，未发送）" : ""}`);

  let after = null;
  const verifyNth = NTH || (plan.nth != null ? String(plan.nth) : null);
  if (!REHEARSE && !NO_VERIFY && verifyNth) {
    console.log("\n重载复核…");
    const tmp = path.join(here, "..", "data", "reply", `verify-${stamp}.json`);
    ensureDir(tmp);
    const r2 = runNode("07-read-video.js", ["--nth", String(verifyNth), "--json", tmp]);
    if (r2.status === 0 || r2.status === 1) {
      try {
        const d = JSON.parse(fs.readFileSync(tmp, "utf8"));
        after = {
          declared: d.declared,
          awaitingThreads: (d.summary || {}).awaitingThreads,
          complete: (d.summary || {}).complete,
          file: tmp,
        };
        console.log(`   声明 ${after.declared} 条｜仍待回 ${after.awaitingThreads} 条｜完整=${after.complete}`);
      } catch {
        console.log("   复核数据读取失败（不影响已发送结果）");
      }
    } else {
      console.log("   复核失败（不影响已发送结果）：" + tail(r2.stderr || r2.stdout, 2));
    }
  }

  const recordFile = JSON_OUT || path.join(here, "..", "data", "reply",
    `result-${path.basename(PLAN_FILE, ".json")}-${stamp}.json`);
  ensureDir(recordFile);
  fs.writeFileSync(recordFile, JSON.stringify({
    finishedAt: new Date().toISOString(),
    mode: REHEARSE ? "rehearse" : "send",
    planFile: path.resolve(PLAN_FILE),
    video: plan.video,
    before: { declared: st0.declared, plannedReplies: replies.length, executed: list.length },
    summary: { ok, failed, rejected, policy },
    after,
    results,
  }, null, 2), "utf8");
  console.log(`记录：${recordFile}`);

  if (failed || rejected) process.exitCode = 1;
}

function readHistorySafe() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(here, "..", "data", "reply", "history.json"), "utf8"));
    return Array.isArray(j.items) ? j.items : [];
  } catch {
    return [];
  }
}

main().catch((e) => {
  console.error("[失败] " + (e.message || e));
  process.exitCode = 1;
});
