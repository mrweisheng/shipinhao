#!/usr/bin/env node
/**
 * 07-read-video.js — 一条命令：打开第 N 条视频 → 读出它的全部评论
 *
 * 内部串行调用：
 *   登录检查             （纯 HTTP；未登录时提示扫码并等待）
 *   03-open-comments.js  （不在评论管理页时才调用，自动进入）
 *   05-open-video.js     （自动把列表滚到第 N 条，点开并核对详情区头部）
 *   06-extract-comments.js（滚动加载全部评论 + 展开折叠回复 + 判断作者是否回复）
 *
 * 不写死任何账号信息：第 N 条由视频列表当前顺序决定，标题/时间/评论全部运行时读取。
 *
 * 用法：
 *   node scripts/07-read-video.js --nth 5
 *   node scripts/07-read-video.js --nth 5 --json .\data\target.json
 *   node scripts/07-read-video.js --nth 5 --unreplied            # 只列出未回复的
 *   node scripts/07-read-video.js --title 埃尔法                 # 标题关键词（唯一命中时）
 *   node scripts/07-read-video.js --nth 5 --wait 600             # 未登录时等扫码 600s
 */

const { execFileSync } = require("child_process");
const path = require("path");
const cdp = require("./lib/cdp");
const login = require("./lib/login");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return d;
};

const NTH = getArg("nth", null);
const TITLE = getArg("title", null);
const PORT = getArg("port", "9222");
const OUT = getArg("json", null);
const WAIT = Number(getArg("wait", "300"));      // 未登录时等扫码的秒数
const UNREPLIED = argv.includes("--unreplied");

if (NTH === null && TITLE === null) {
  console.error("需要 --nth N（第几条，从 1 开始）或 --title 关键词");
  process.exit(1);
}

const here = __dirname;
const run = (script, args) => {
  execFileSync(process.execPath, [path.join(here, script), ...args], {
    stdio: "inherit",
    env: process.env,
  });
};

/** 读 06 产出的 JSON，判断是不是「抓到的比页面声明的少」 */
function incomplete(jsonFile) {
  try {
    const fs = require("fs");
    if (!fs.existsSync(jsonFile)) return null;
    const j = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
    const s = j.summary || {};
    if (typeof s.declared !== "number") return null;
    return {
      declared: s.declared,
      total: s.total,
      complete: s.complete === true,
      gap: typeof s.gap === "number" ? s.gap : s.declared - s.total,
      leftExpand: s.leftExpand,
      unreachable: s.unreachable === true,
    };
  } catch {
    return null;
  }
}

/** 整页重载并等评论列表重新渲染（用于评论区卡在「加载中」时复位） */
async function reloadComments() {
  const pages = await cdp.listPages(Number(PORT));
  const p = pages.find((x) => x.type === "page" && x.url.includes("channels.weixin.qq.com/platform"));
  if (!p) return false;
  const { send, close } = await cdp.attach(p.webSocketDebuggerUrl);
  try {
    await cdp.evaluate(send, "location.reload()").catch(() => {});
    await cdp.sleep(1200);
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const n = await cdp
        .evaluate(
          send,
          `(() => {
            const host = document.querySelector("wujie-app");
            const root = host && host.shadowRoot;
            return root ? root.querySelectorAll(".comment-feed-wrap").length : 0;
          })()`
        )
        .catch(() => 0);
      if (n > 0) return true;
      await cdp.sleep(400);
    }
    return false;
  } finally {
    close();
  }
}

/** 当前是否已经在评论管理页（只看 URL，不建 CDP 会话） */
async function onCommentPage() {
  try {
    const pages = await cdp.listPages(Number(PORT));
    const p =
      pages.find((x) => x.type === "page" && x.url.includes("channels.weixin.qq.com/platform")) ||
      pages.find((x) => x.type === "page" && x.url.includes("channels.weixin.qq.com"));
    return !!p && p.url.includes("interaction/comment");
  } catch {
    return false;
  }
}

(async () => {
  const t0 = Date.now();
  const step = (n, s) => console.log(`${n} ${s}`);

  // ⓿ 每次任务开始前检查登录（纯 HTTP）：未登录就提醒扫码，不硬闯
  const auth = await login.requireLogin({ port: Number(PORT), wait: WAIT });
  if (!auth.ok) {
    console.error(
      auth.code === 3
        ? "✗ 浏览器未就绪：请先运行 scripts\\01-launch-clean-chrome.ps1 并扫码登录"
        : "✗ 等待登录超时：请扫码登录后重新运行"
    );
    process.exit(auth.code);
  }

  if (!(await onCommentPage())) {
    step("①", "进入评论管理…");
    run("03-open-comments.js", ["--port", PORT, "--wait", "0"]);
  } else {
    step("①", "已在评论管理页，跳过导航");
  }

  const openArgs = ["--port", PORT];
  if (NTH !== null) openArgs.push("--nth", String(NTH));
  else openArgs.push("--title", TITLE);

  step("②", "定位并打开目标视频…");
  run("05-open-video.js", openArgs);

  step("③", "读取全部评论…");
  const extractArgs = ["--port", PORT];
  const jsonOut = OUT || `./data/comments-${NTH !== null ? `nth${NTH}` : "by-title"}.json`;
  extractArgs.push("--json", jsonOut);
  if (UNREPLIED) extractArgs.push("--unreplied");

  let extractErr = null;
  try {
    run("06-extract-comments.js", extractArgs);
  } catch (e) {
    extractErr = e;
  }

  // 评论没抓全（典型：某个「展开更多回复」卡在加载中，组件会忽略后续点击）：
  // 整页重载复位一次，再重新打开同一条视频抓一遍。
  const inc = incomplete(jsonOut);
  let acceptedGap = null;

  // 折叠已全部展开、列表已到底，只是服务端计数比实际下发多几条：
  // 重载也拿不到（实测第 28 条 894/896，两次完全一样），不要白白再等一轮。
  const tinyUnreachable = (x) => x && x.unreachable && x.gap <= 5;

  if (extractErr && inc && !inc.complete) {
    if (tinyUnreachable(inc)) {
      acceptedGap = inc;
      console.log(
        `\n⚠ 缺口 ${inc.gap} 条（${inc.total}/${inc.declared}）属于服务端计数差异：` +
          `折叠已全部展开、列表已到底，评论接口同样只下发 ${inc.total} 条。跳过重载重试。`
      );
    } else {
      console.log(
        `\n⚠ 只抓到 ${inc.total}/${inc.declared} 条评论，重载页面复位后重试一次（序号顺序不变）…`
      );
      const ok = await reloadComments();
      if (ok) {
        step("③-重试", "重新定位并打开同一条视频…");
        try {
          run("05-open-video.js", openArgs);
          run("06-extract-comments.js", extractArgs);
          extractErr = null;
        } catch (e) {
          extractErr = e;
        }
        const inc2 = incomplete(jsonOut);
        if (extractErr && tinyUnreachable(inc2)) {
          acceptedGap = inc2;
          console.log(
            `\n⚠ 重试后仍是 ${inc2.total}/${inc2.declared}，确认是服务端计数差异（不是抓取问题）。`
          );
        }
      } else {
        console.log("⚠ 重载后列表未就绪，放弃重试");
      }
    }
  }

  if (extractErr && !acceptedGap) throw extractErr;

  if (acceptedGap) {
    console.log(
      `\n⚠ 已尽量取全：${acceptedGap.total}/${acceptedGap.declared} 条，` +
        `缺的 ${acceptedGap.gap} 条评论接口不下发（通常是已删除/审核中但仍计数）。`
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\n完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch((e) => {
  console.error("[失败] " + (e.message || e));
  process.exit(1);
});
