#!/usr/bin/env node
/**
 * 12-prepare-plan.js — 读一条视频，生成「待判断清单」给模型填
 *
 * 这个脚本不做分类、不选话术：只把评论整理成结构化清单，避免模型看漏。
 * 模型填完 action/text 后，用 13-execute-plan.js 执行。
 *
 * 用法：
 *   node scripts/12-prepare-plan.js --nth 6
 *   node scripts/12-prepare-plan.js --input .\data\comments-nth6.json --out .\data\reply\plan-nth6.json
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { keywordOf, detectContext } = require("./lib/plan");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return d;
};
const has = (n) => argv.includes(`--${n}`);

const NTH = getArg("nth", null);
const INPUT = getArg("input", null);
const OUT = getArg("out", null);
const here = __dirname;

function run07(nth) {
  const tmp = path.join(here, "..", "data", "reply", `read-nth${nth}-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  const r = spawnSync(process.execPath, [path.join(here, "07-read-video.js"), "--nth", String(nth), "--json", tmp], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  // 07 在「声明数比实抓多 1–5 条」时会以 1 退出，但 JSON 是完整可用的
  if (r.status !== 0) {
    if (r.status === 1 && fs.existsSync(tmp)) {
      console.log("⚠ 读取完成，但服务端计数有 1–5 条缺口（按实际抓到的继续）");
    } else {
      throw new Error(`读取第 ${nth} 条失败（退出码 ${r.status}）：\n${String(r.stderr || r.stdout).split(/\r?\n/).slice(-5).join("\n")}`);
    }
  }
  return { data: JSON.parse(fs.readFileSync(tmp, "utf8")), file: tmp };
}

function main() {
  let data;
  let source;
  if (INPUT) {
    data = JSON.parse(fs.readFileSync(INPUT, "utf8"));
    source = path.resolve(INPUT);
  } else if (NTH !== null) {
    const r = run07(NTH);
    data = r.data;
    source = r.file;
  } else {
    console.error("需要 --nth N 或 --input <07 产出的 json>");
    process.exitCode = 1;
    return;
  }

  const comments = Array.isArray(data.comments) ? data.comments : [];
  const l1 = comments.filter((c) => c.level === 1);
  const pending = l1.filter((c) => !c.authorReplied && !c.isAuthor);
  const replied = l1.filter((c) => c.authorReplied);
  const own = l1.filter((c) => c.isAuthor);

  const plan = {
    createdAt: new Date().toISOString(),
    nth: NTH !== null ? Number(NTH) : null,
    video: data.video || null,
    titleContext: detectContext(data.video && data.video.title),
    declared: data.declared ?? null,
    source,
    rules: {
      facts: "业务事实.md（唯一事实来源：价格/付款/车况/地址/移民/求职）",
      judgment: ".opencode/skills/channels-comment-ops/SKILL.md（回不回、红线、动作分类）",
      cases: "data/cases/（主参考：先判意图 → 检索 2 好 1 坏 → 仿写）",
      style: "模板池.md（仅 GUIDE-* 引导尾巴与兜底候选，按语义改写，不要关键词对号入座）",
    },
    counts: {
      topLevel: l1.length,
      authorReplied: replied.length,
      authorOwn: own.length,
      pending: pending.length,
    },
    items: pending.map((c) => ({
      index: c.index,
      name: (c.author || "").trim(),
      time: c.time,
      likes: c.likes,
      content: (c.content || "").trim(),
      kw: keywordOf(c.content),
      asked: "",        // ← 模型填：客户实际在问什么（一句话复述）
      action: null,     // ← 模型填：reply / skip
      text: "",         // ← 模型填：仅 reply 需要
      answerOk: false,  // ← 模型填：正文是否直接回答了 asked
      category: "",     // ← 模型填：自由标签，用于复盘统计
      reason: "",       // ← 模型填：判断依据（skip 必填）
    })),
  };

  const out = OUT || path.join(here, "..", "data", "reply",
    NTH !== null ? `plan-nth${NTH}.json` : "plan-input.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(plan, null, 2), "utf8");

  console.log(`\n视频：${(data.video && data.video.title) || "（无标题）"}`);
  console.log(`时间：${(data.video && data.video.time) || "?"}`);
  console.log(`声明：${data.declared ?? "?"} 条｜一级 ${l1.length}｜作者已回 ${replied.length}｜作者自评 ${own.length}｜待判断 ${pending.length}`);
  const ctx = plan.titleContext;
  console.log(`标题背景：业务=${ctx.business}｜口岸=${ctx.ports.join("/") || "-"}｜车型=${ctx.models.join("/") || "-"}｜标价=${ctx.price || "未标价"}`);
  console.log("（标题只作背景参考；评论本身是正向业务咨询就必须回，方言标题看不懂不影响判断）");

  if (!pending.length) {
    console.log("\n没有待判断的评论。");
  } else {
    console.log("\n#    昵称                        时间              赞  评论");
    for (const c of pending) {
      const name = (c.author || "").padEnd(24, " ").slice(0, 24);
      const text = (c.content || "").replace(/\s+/g, " ").slice(0, 42);
      console.log(`${String(c.index).padEnd(4)} ${name} ${(c.time || "").padEnd(16)} ${String(c.likes ?? "").padEnd(3)} ${text}`);
    }
  }

  console.log(`\n清单已生成：${out}`);
  console.log("下一步：按规则填 action（reply/skip），reply 填 text；");
  console.log(`然后运行：node scripts\\13-execute-plan.js --plan "${out}" --send`);
}

main();
