#!/usr/bin/env node
/**
 * 09-selftest.js — 随机端到端测试
 *
 * 每一轮做四件事：
 *   1. 先离开评论页（随机菜单入口，交替用「真实点击」和「直接改 URL」两种方式）
 *   2. 让 07 自己找回「视频列表（评论管理）」并把列表滚到目标序号
 *   3. 读该视频的全部评论，判断作者是否回复
 *   4. 校验结果自洽：声明数=实抓数、一级+回复=总数、已回+未回=一级
 *
 * 失败时会自动跑结构自检，打印候选元素，方便纠正定位。
 *
 * 用法：
 *   node scripts/09-selftest.js                     # 默认 5 轮
 *   node scripts/09-selftest.js --rounds 8
 *   node scripts/09-selftest.js --nth 1,5,10        # 指定要读的序号
 *   node scripts/09-selftest.js --seed 12345        # 复现同一串随机
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const cdp = require("./lib/cdp");
const nav = require("./lib/nav");
const login = require("./lib/login");
const layout = require("./lib/layout-map");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return d;
};

const ROUNDS = Number(getArg("rounds", "5"));
const NTH_ARG = getArg("nth", null);
const PORT = Number(getArg("port", "9222"));
const WAIT = Number(getArg("wait", "0"));
let seed = Number(getArg("seed", String(Date.now() % 1e9)));
const SEED0 = seed;

// ── 可复现的伪随机 ────────────────────────────────────────
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const normTime = (s) => {
  if (!s) return null;
  const m = String(s).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{1,2}):(\d{2})/);
  if (!m) return String(s).replace(/\s+/g, "");
  return `${m[1]}/${String(m[2]).padStart(2, "0")}/${String(m[3]).padStart(2, "0")} ` +
         `${String(m[4]).padStart(2, "0")}:${m[5]}`;
};

// ── 页面操作 ──────────────────────────────────────────────
async function getSession() {
  const pages = await cdp.listPages(PORT);
  const page = pages.find((p) => p.type === "page" && p.url.includes("channels.weixin.qq.com/platform"));
  if (!page) throw new Error("不在视频号后台页面");
  return cdp.attach(page.webSocketDebuggerUrl);
}

async function closeExtraTabs(beforeIds) {
  const pages = await cdp.listPages(PORT).catch(() => []);
  for (const p of pages) {
    if (p.type === "page" && !beforeIds.has(p.id)) {
      await cdp.closeTarget(PORT, p.id);
    }
  }
}

/** 选择要「跳去」的页面 */
function loadRoutes() {
  const file = path.join(DATA, "routes.json");
  if (!fs.existsSync(file)) return [];
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    const seen = new Set();
    return (d.results || []).filter((r) => {
      if (!r.ok || !r.url || !r.url.includes("/platform")) return false;
      if (r.url.includes("/interaction/comment")) return false;   // 不能原地不动
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });
  } catch {
    return [];
  }
}

/** 离开评论页：mode = click（真实点菜单）| url（直接改地址） */
async function leaveCommentPage(send, route, mode) {
  const before = await cdp.evaluate(send, "location.href");
  const beforeIds = new Set((await cdp.listPages(PORT)).map((p) => p.id));

  // 直接改地址会整页重载：等外壳（侧边栏 / shadowRoot）重新挂载
  const waitShell = async () => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const ok = await cdp
        .evaluate(
          send,
          `(() => {
            const host = document.querySelector("wujie-app");
            return document.querySelectorAll(".finder-ui-desktop-menu__link").length > 4 || !!(host && host.shadowRoot);
          })()`
        )
        .catch(() => false);
      if (ok) return true;
      await cdp.sleep(400);
    }
    return false;
  };

  if (mode === "click" && route.parent && route.child) {
    try {
      await nav.clickMenuPath(send, route.parent, route.child);
    } catch {
      /* 落到 URL 方式兜底 */
    }
  }
  // 等 URL 离开评论页
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    await cdp.sleep(250);
    const now = await cdp.evaluate(send, "location.href").catch(() => before);
    if (now !== before && !now.includes("/interaction/comment")) {
      await waitShell();
      await closeExtraTabs(beforeIds);
      return now;
    }
  }
  // 兜底：直接改 URL
  await cdp.evaluate(send, `location.href = ${JSON.stringify(route.url)}`).catch(() => {});
  await cdp.sleep(1200);
  await waitShell();
  await closeExtraTabs(beforeIds);
  return cdp.evaluate(send, "location.href").catch(() => route.url);
}

// ── 运行 07 并解析输出 ────────────────────────────────────
function runRead(nth, outFile) {
  const t0 = Date.now();
  const r = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "07-read-video.js"),
      "--nth", String(nth),
      "--json", outFile,
      "--port", String(PORT),
      "--wait", String(WAIT),
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 300000, maxBuffer: 64 * 1024 * 1024 }
  );
  const ms = Date.now() - t0;
  const stdout = (r.stdout || "") + (r.stderr || "");

  const mOpened = stdout.match(/点开第\s*(\d+)\s*条/);
  const mTitle = stdout.match(/^\s*标题：(.*)$/m);
  const mTime = stdout.match(/^\s*时间：(.*)$/m);
  const mConfirmed = /✓ 已确认打开：(.+)/.exec(stdout);
  const mDeclared = stdout.match(/共\s*(\d+)\s*条评论（页面声明\s*(\d+)）/);
  const complete = /✓ 完整/.test(stdout) ? true : /⚠ 可能不全/.test(stdout) ? false : null;

  return {
    code: r.status,
    ms,
    stdout,
    openedNth: mOpened ? Number(mOpened[1]) : null,
    title: mTitle ? mTitle[1].trim() : null,
    time: mTime ? mTime[1].trim() : null,
    confirmedTime: mConfirmed ? mConfirmed[1].trim() : null,
    declared: mDeclared ? Number(mDeclared[2]) : null,
    total: mDeclared ? Number(mDeclared[1]) : null,
    complete,
  };
}

function validate(run, nth) {
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });

  add("退出码 0", run.code === 0, run.code !== 0 ? `exit=${run.code}` : "");
  add("点开的正是第 N 条", run.openedNth === nth, `期望 ${nth}，实际 ${run.openedNth}`);
  add("详情区头部已核对", !!run.confirmedTime, run.confirmedTime || "未见「已确认打开」");

  const j = run.json;
  if (!j) {
    add("结果 JSON 可读", false, "文件不存在或解析失败");
    return { checks, ok: false };
  }
  const s = j.summary || {};
  add("输出含 summary", !!j.summary, "");
  add("声明数 = 实抓数", j.declared === null || s.declared === undefined ? true : s.declared === s.total,
      `声明 ${s.declared} / 实抓 ${s.total}`);
  add("一级 + 回复 = 总数", s.level1 + s.level2 === s.total, `${s.level1}+${s.level2} vs ${s.total}`);
  add("已回 + 未回 = 一级", s.authorRepliedThreads + s.awaitingThreads === s.level1,
      `${s.authorRepliedThreads}+${s.awaitingThreads} vs ${s.level1}`);
  add("完整性标记", s.complete === true, String(s.complete));
  add("评论数与页面声明一致", run.declared === null || run.declared === s.declared,
      `页面 ${run.declared} / JSON ${s.declared}`);
  add("视频时间与头部一致",
      !run.confirmedTime || !j.video || !j.video.time || normTime(run.confirmedTime) === normTime(j.video.time),
      `${run.confirmedTime} vs ${j.video && j.video.time}`);

  const ok = checks.every((c) => c.ok);
  return { checks, ok, summary: s };
}

/** 失败时的纠错：跑结构自检，打印候选 */
async function diagnose(log) {
  try {
    const { send, close } = await getSession();
    try {
      const url = await cdp.evaluate(send, "location.href").catch(() => "");
      if (!url.includes("/interaction/comment")) {
        log(`\n（当前在 ${url}，不在评论页，跳过结构自检）`);
        return;
      }
      const raw = await layout.check(send);
      const context = !!(raw && raw.items.detailHeader && raw.items.detailHeader.count > 0);
      log("\n--- 结构自检（用于纠正定位）---");
      layout.print(raw, { context, log });
      log("");
    } finally {
      close();
    }
  } catch (e) {
    log(`（自检也失败：${e.message}）`);
  }
}

// ── 主流程 ────────────────────────────────────────────────
(async () => {
  console.log(`随机测试：${ROUNDS} 轮，seed=${SEED0}\n`);

  const auth = await login.requireLogin({ port: PORT, wait: 300 });
  if (!auth.ok) process.exit(auth.code);

  // 视频总数：优先用已有列表；没有就先跑 04
  let totalVideos = 0;
  const vfile = path.join(DATA, "videos.json");
  if (fs.existsSync(vfile)) {
    try { totalVideos = JSON.parse(fs.readFileSync(vfile, "utf8")).count || 0; } catch { /* ignore */ }
  }
  if (!totalVideos) {
    console.log("还没有视频列表，先跑 04 取总数…");
    spawnSync(process.execPath, [path.join(ROOT, "scripts", "04-list-videos.js")], {
      cwd: ROOT, stdio: "inherit",
    });
    try { totalVideos = JSON.parse(fs.readFileSync(vfile, "utf8")).count || 0; } catch { /* ignore */ }
  }
  console.log(`已知视频数：${totalVideos || "未知"}\n`);

  const routes = loadRoutes();
  console.log(`可用跳转目标：${routes.length} 个（来自 data/routes.json）\n`);

  const pool = NTH_ARG
    ? NTH_ARG.split(",").map((s) => Number(s.trim())).filter((n) => n > 0)
    : [1, 2, 3, 5, 8, 10, 15, 20, 30, 50, 100, 150].filter((n) => !totalVideos || n <= totalVideos);

  const results = [];
  const t0 = Date.now();

  for (let i = 0; i < ROUNDS; i++) {
    const nth = NTH_ARG ? pool[i % pool.length] : totalVideos
      ? pick(pool.concat([1 + Math.floor(rnd() * totalVideos)]))
      : pick(pool);

    const mode = i % 2 === 0 ? "url" : "click";
    const route = routes.length
      ? pick(routes)
      : { url: "https://channels.weixin.qq.com/platform/home", parent: null, child: null };

    console.log(`\n──────── 第 ${i + 1}/${ROUNDS} 轮：${mode === "click" ? "点菜单" : "改地址"}去「${route.parent ? `${route.parent}→${route.child}` : route.url}」，再读第 ${nth} 条 ────────`);

    let from = null;
    let run = null;
    let verdict = { ok: false, checks: [] };

    try {
      const { send, close } = await getSession();
      try {
        from = await leaveCommentPage(send, route, mode);
      } finally {
        close();
      }
      console.log(`已离开评论页 → ${from}`);
      if (String(from).includes("/interaction/comment")) {
        throw new Error("没能离开评论页（跳转失败）");
      }

      const outFile = path.join(DATA, "selftest", `r${i + 1}-nth${nth}.json`);
      fs.mkdirSync(path.dirname(outFile), { recursive: true });

      run = runRead(nth, outFile);
      let expectNth = nth;
      if (run.code !== 0 && /没有第\s*\d+\s*条/.test(run.stdout) && totalVideos && nth > 1) {
        // 视频变多了/列表变小了：降级重试一次，避免测试被陈旧总数卡住
        const retryNth = Math.max(1, Math.min(nth, totalVideos) - 1);
        console.log(`列表比缓存的少，改用第 ${retryNth} 条重试…`);
        run = runRead(retryNth, outFile);
        expectNth = retryNth;
      }
      run.expectNth = expectNth;

      if (fs.existsSync(outFile)) {
        try { run.json = JSON.parse(fs.readFileSync(outFile, "utf8")); } catch { /* ignore */ }
      }
      verdict = validate(run, expectNth);

      // 慢轮次（多半走了重载恢复）留完整日志，便于事后分析，不必等它失败
      if (run.ms > 25000) {
        const slowLog = path.join(DATA, "selftest", `r${i + 1}-nth${expectNth}-slow.txt`);
        fs.writeFileSync(slowLog, run.stdout, "utf8");
        console.log(`本轮偏慢（${(run.ms / 1000).toFixed(1)}s），日志：${slowLog}`);
      }

      const s = verdict.summary || {};
      console.log(
        `耗时 ${(run.ms / 1000).toFixed(1)}s · 评论 ${s.total ?? "?"} 条（声明 ${s.declared ?? "?"}）` +
          ` · 一级 ${s.level1 ?? "?"}（已回 ${s.authorRepliedThreads ?? "?"} / 未回 ${s.awaitingThreads ?? "?"}）`
      );
      console.log(verdict.ok ? "✓ 本轮通过" : "✗ 本轮失败：" +
        verdict.checks.filter((c) => !c.ok).map((c) => `${c.name}（${c.detail}）`).join("；"));

      if (!verdict.ok) {
        const logFile = path.join(DATA, "selftest", `r${i + 1}-failed.txt`);
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.writeFileSync(logFile, run.stdout, "utf8");
        console.log(`完整日志：${logFile}`);
        console.log(run.stdout.split("\n").slice(-25).join("\n"));
        await diagnose(console.log);
      }
    } catch (e) {
      console.log(`✗ 异常：${e.message}`);
      verdict = { ok: false, checks: [{ name: "执行", ok: false, detail: e.message }] };
      await diagnose(console.log);
    }

    results.push({
      round: i + 1,
      mode,
      from,
      route: { parent: route.parent, child: route.child, url: route.url },
      nth: run && run.expectNth ? run.expectNth : nth,
      ms: run ? run.ms : null,
      code: run ? run.code : null,
      summary: verdict.summary || null,
      checks: verdict.checks,
      ok: verdict.ok,
    });
  }

  // ── 汇总 ────────────────────────────────────────────────
  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n${"=".repeat(78)}`);
  console.log(`汇总：${okCount}/${results.length} 轮通过，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，seed=${SEED0}`);
  console.log("=".repeat(78));
  console.log(
    "轮次  方式   起点".padEnd(46) + "序号   耗时    评论   一级(已回/未回)   结果"
  );
  for (const r of results) {
    const s = r.summary || {};
    const fromShort = String(r.from || "?").replace("https://channels.weixin.qq.com", "");
    const left = (r.mode === "click" ? "点菜单" : "改地址") + "  " + fromShort.slice(0, 34);
    const stat = s.total === undefined ? "-" : `${s.total} 条`;
    const l1 = s.level1 === undefined ? "-" : `${s.level1} (${s.authorRepliedThreads}/${s.awaitingThreads})`;
    console.log(
      `${String(r.round).padEnd(5)} ${left.padEnd(42)} ${String(r.nth).padEnd(5)} ` +
        `${r.ms != null ? (r.ms / 1000).toFixed(1) + "s" : "-"}`.padEnd(9) +
        `${stat.padEnd(7)} ${l1.padEnd(18)} ${r.ok ? "✓" : "✗"}`
    );
  }

  const outJson = path.join(DATA, `selftest-${stamp()}.json`);
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(
    outJson,
    JSON.stringify({ when: new Date().toISOString(), seed: SEED0, totalVideos, results }, null, 2),
    "utf8"
  );
  fs.appendFileSync(
    path.join(DATA, "selftest-log.jsonl"),
    JSON.stringify({ when: new Date().toISOString(), seed: SEED0, rounds: results.length, passed: okCount }) + "\n",
    "utf8"
  );
  console.log(`\n已保存：${outJson}`);

  // 不用 process.exit：Node 24 在 Windows 上带子进程退出时可能触发 libuv 断言
  process.exitCode = okCount === results.length ? 0 : 1;
})().catch((e) => {
  console.error("[失败] " + e.message);
  process.exit(1);
});
