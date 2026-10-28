#!/usr/bin/env node
/**
 * 08-reply-comment.js — 回复「一条」一级评论，并做三信号核验（真实点击 + 真实键盘）
 *
 * 纪律（规则总纲硬约束，脚本内会自检，不通过不发）：
 *   - 只回一次：目标线程里已有作者回复（昵称白名单 或「作者」badge）→ 直接放弃
 *   - 不出现联系方式 / 防吞红线词 → 直接放弃
 *   - 定位用「昵称片段 + 内容关键词」，不用时间戳（跨轮次会漂）
 *
 * 用法：
 *   node scripts/08-reply-comment.js --name 健文 --kw 订购一台白色 --text "白色有得傾，多謝支持 🙏"
 *   node scripts/08-reply-comment.js ... --dry          # 只开到面板、输入、校验按钮，不点发送
 *   node scripts/08-reply-comment.js ... --expect 23    # 发送前计数（不匹配就中止）
 *
 * 退出码：0 成功 / 1 未确认 / 4 策略拦截（已回、红线、定位不唯一）/ 5 服务端拒绝（原因见 trace）
 */

const fs = require("fs");
const path = require("path");
const cdp = require("./lib/cdp");

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return d;
};

const PORT = Number(getArg("port", 9222));
const NAME = getArg("name", null);
const KW = getArg("kw", null);
const TEXT = getArg("text", null);
const EXPECT = getArg("expect", null);
const DRY = argv.includes("--dry");
const LIKE = argv.includes("--like");
const OUT = getArg("json", null);

if (!NAME || !KW || !TEXT) {
  console.error("需要 --name 昵称片段 --kw 内容关键词 --text 回复文案");
  process.exit(1);
}

/** 作者身份（可配置）：两个主号 + 小号；badge「作者」也算 */
const AUTHOR_NAMES = ["明哥揀粤港车", "明哥揾粤港车", "明哥粤港车"];

/**
 * 引导红线（2026-10-24 恢复旧策略）
 *   - 允许：點頭像 / 睇簡介 / 私訊 / 置頂 / 主頁 等引导，且可以组合成完整路径
 *   - 仍然禁止：微信、VX、電話、手機、加我、二維碼、號碼、聯繫/聯絡、明示私下聊
 *   - 不支持也不阻拦“变形写法”（点号、放大镜等）；变体越丰富越好
 */
const HARD = [
  "微信", "vx", "wechat", "電話", "电话", "手機", "手机", "加我",
  "二維碼", "二维码", "號碼", "号码",
  "聯繫方式", "联系方式", "聯絡方式", "联络方式",
  "私信",  // 简体「私信」历史上有被吞记录，统一用繁体「私訊」
  "唔方便喺度講", "唔方便喺度讲", "私下講", "私下讲",
];

function checkText(t) {
  const low = t.toLowerCase();
  const hits = HARD.filter((w) => low.includes(w.toLowerCase()));
  if (hits.length) return hits;

  if ([...t.replace(/\s/g, "")].length > 22) return ["超过 22 字上限（含标点）"];
  if (!/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(t)) return ["缺少表情"];
  return [];
}

const STATE = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return { error: "wujie shadow root 不存在" };
  const sel = root.querySelector(".feed-selected-info");
  const t = sel && sel.querySelector(".feed-title");
  const tm = sel && sel.querySelector(".feed-time");
  const tips = root.querySelector(".comment-count__tips");
  const m = tips ? (tips.innerText || "").match(/(\\d+)\\s*条/) : null;
  return {
    video: {
      title: t ? (t.innerText || "").replace(/\\s+/g, " ").trim() : null,
      time: tm ? (tm.innerText || "").replace(/\\s+/g, " ").trim() : null,
    },
    declared: m ? Number(m[1]) : null,
    rendered: root.querySelectorAll(".comment-item").length,
    textareas: root.querySelectorAll("textarea.create-input").length,
  };
})()`;

/** 定位一级评论 + 作者是否已回 + 回复气泡坐标 */
const LOCATE = (name, kw) => `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return { error: "wujie shadow root 不存在" };
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const flat = (s) => (s || "").replace(/\\s+/g, "");
  const items = [...root.querySelectorAll(".comment-item")].filter((el) => !el.closest(".comment-reply-list"));
  const hits = items.filter((el) => {
    const n = el.querySelector(".comment-user-name");
    const c = el.querySelector(".comment-content");
    // 昵称/正文都按「去掉所有空白」比对：页面里的连续空格、换行、以及 kw 跨空格都会导致 includes 失败
    return n && flat(n.innerText).includes(flat(${JSON.stringify(name)}))
        && c && flat(c.innerText).includes(flat(${JSON.stringify(kw)}));
  });
  if (hits.length !== 1) return { found: hits.length };
  const el = hits[0];
  const authors = ${JSON.stringify(AUTHOR_NAMES)};
  const reps = [...el.querySelectorAll(".comment-reply-list .comment-item")].map((r) => {
    const rn = norm(r.querySelector(".comment-user-name")?.innerText || "");
    const row = norm(r.querySelector(".comment-row")?.innerText || "");
    return {
      name: rn,
      text: norm(r.querySelector(".comment-content")?.innerText || ""),
      isAuthor: row.includes("作者") || authors.includes(rn),
    };
  });
  el.scrollIntoView({ block: "center" });
  const btn = el.querySelector(".action-icon.weui-icon-outlined-comment");
  if (!btn) return { found: 1, error: "NO_REPLY_BTN" };
  const r = btn.getBoundingClientRect();
  const lm = el.querySelector(".load-more");
  let loadMore = null;
  if (lm) {
    const lr = lm.getBoundingClientRect();
    loadMore = {
      spinning: !!lm.querySelector(".infinite-spin"),
      text: norm(lm.innerText || ""),
      x: Math.round(lr.left + lr.width / 2),
      y: Math.round(lr.top + lr.height / 2),
    };
  }
  return {
    found: 1,
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    item: {
      name: norm(el.querySelector(".comment-user-name")?.innerText || ""),
      time: norm(el.querySelector(".comment-time")?.innerText || ""),
      text: norm(el.querySelector(".comment-content")?.innerText || ""),
    },
    replies: reps,
    loadMore,
    authorReplied: reps.some((x) => x.isAuthor),
  };
})()`;

const PANEL = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return { error: "wujie shadow root 不存在" };
  const ta = root.querySelector("textarea.create-input");
  if (!ta) return { textareas: 0 };
  const item = ta.closest(".comment-item");
  const btns = item ? [...item.querySelectorAll(".create-ft .tag-wrap")] : [];
  const sendBtn = btns.find((b) => (b.innerText || "").trim() === "评论");
  return {
    textareas: root.querySelectorAll("textarea.create-input").length,
    placeholder: ta.getAttribute("placeholder"),
    value: ta.value,
    ta: (() => { const r = ta.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })(),
    buttons: btns.map((b) => ({ text: (b.innerText || "").trim(), cls: String(b.className) })),
    send: sendBtn ? (() => {
      const r = sendBtn.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      const hit = root.elementFromPoint ? root.elementFromPoint(cx, cy) : document.elementFromPoint(cx, cy);
      return {
        text: (sendBtn.innerText || "").trim(),
        cls: String(sendBtn.className),
        enabled: /primary/.test(String(sendBtn.className)) && !/disabled/.test(String(sendBtn.className)),
        x: cx,
        y: cy,
        covered: !(hit && (hit === sendBtn || sendBtn.contains(hit))),
        hit: hit ? { tag: hit.tagName, cls: String(hit.className || "").slice(0, 40) } : null,
      };
    })() : null,
  };
})()`;

/** 三信号：计数、textarea、目标线程里是否出现这句回复 */
const VERIFY = (name, kw, text) => `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return { error: "wujie shadow root 不存在" };
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const strip = (s) => (s || "")
    .replace(/[\\u{1F300}-\\u{1FAFF}\\u2600-\\u27BF\\uFE0F]/gu, "")
    .replace(/\\s+/g, "");
  const authors = ${JSON.stringify(AUTHOR_NAMES)};
  // 表情在 DOM 里是 img，innerText 会丢；比对时两边都去表情、去空格
  const needle = strip(${JSON.stringify(text)}).slice(0, 8);
  const tips = root.querySelector(".comment-count__tips");
  const m = tips ? (tips.innerText || "").match(/(\\d+)\\s*条/) : null;
  const items = [...root.querySelectorAll(".comment-item")].filter((el) => !el.closest(".comment-reply-list"));
  const el = items.find((x) => {
    const n = x.querySelector(".comment-user-name");
    const c = x.querySelector(".comment-content");
    return n && strip(n.innerText).includes(strip(${JSON.stringify(name)}))
        && c && strip(c.innerText).includes(strip(${JSON.stringify(kw)}));
  });
  const reps = el ? [...el.querySelectorAll(".comment-reply-list .comment-item")].map((r) => ({
    name: norm(r.querySelector(".comment-user-name")?.innerText || ""),
    text: norm(r.querySelector(".comment-content")?.innerText || ""),
  })) : [];
  const mine = reps.filter((r) => authors.includes(r.name));
  return {
    declared: m ? Number(m[1]) : null,
    textareas: root.querySelectorAll("textarea.create-input").length,
    found: !!el,
    replies: reps,
    hit: needle ? mine.some((r) => strip(r.text).includes(needle)) : mine.length > 0,
  };
})()`;

const sleep = cdp.sleep;

/** 点「评论」：先滚到视口中间，避免被页脚/浮层盖住；仍被盖就退化为 DOM 点击 */
async function clickSend(send) {
  await cdp.evaluate(send, `(() => {
    const root = document.querySelector("wujie-app").shadowRoot;
    const ta = root.querySelector("textarea.create-input");
    if (ta) ta.scrollIntoView({ block: "center" });
    return !!ta;
  })()`);
  await sleep(320);

  let p = await cdp.evaluate(send, PANEL);
  if (!p || !p.send || !p.send.enabled) return p;

  if (p.send.covered) {
    const ok = await cdp.evaluate(send, `(() => {
      const root = document.querySelector("wujie-app").shadowRoot;
      const ta = root.querySelector("textarea.create-input");
      const item = ta && ta.closest(".comment-item");
      const btn = item && [...item.querySelectorAll(".create-ft .tag-wrap")]
        .find((b) => (b.innerText || "").trim() === "评论");
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    return { ...p, domClick: ok };
  }

  await cdp.clickAt(send, p.send.x, p.send.y);
  return p;
}

/** 定位目标评论的点赞按钮 + 是否已赞 */
const LIKE_JS = (name, kw) => `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return null;
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const flat = (s) => (s || "").replace(/\\s+/g, "");
  const items = [...root.querySelectorAll(".comment-item")].filter((el) => !el.closest(".comment-reply-list"));
  const el = items.find((x) => {
    const n = x.querySelector(".comment-user-name");
    const c = x.querySelector(".comment-content");
    return n && flat(n.innerText).includes(flat(${JSON.stringify(name)}))
        && c && flat(c.innerText).includes(flat(${JSON.stringify(kw)}));
  });
  if (!el) return null;
  const la = el.querySelector(".like-action");
  if (!la) return null;
  el.scrollIntoView({ block: "center" });
  const svg = la.querySelector("svg");
  const r = la.getBoundingClientRect();
  return {
    liked: !!(svg && svg.classList.contains("fill-like")),
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
  };
})()`;

async function likeTarget(send, name, kw) {
  let lk = await cdp.evaluate(send, LIKE_JS(name, kw));
  if (!lk) return { ok: false, reason: "找不到点赞按钮" };
  if (lk.liked) return { ok: true, already: true };
  await cdp.clickAt(send, lk.x, lk.y);
  for (let i = 0; i < 10; i++) {
    await sleep(400);
    lk = await cdp.evaluate(send, LIKE_JS(name, kw));
    if (lk && lk.liked) return { ok: true };
  }
  return { ok: false, reason: "点了但没变红" };
}

/**
 * 发送链路抓包：只记录 comment 写请求，用来回答「为什么被拒」。
 * 不改变发送行为；拿到 Network 响应后自动关闭。
 */
function startTrace(send, on) {
  const requests = new Map();
  const isWrite = (url) => /comment/i.test(url) && /(create|add|publish|reply|insert)/i.test(url);

  on("Network.requestWillBeSent", (p) => {
    if (p.request.method !== "POST") return;
    if (!isWrite(p.request.url)) return;
    requests.set(p.requestId, {
      requestId: p.requestId,
      url: p.request.url,
      method: p.request.method,
      postData: (p.request.postData || "").slice(0, 2000),
      ts: new Date().toISOString(),
      status: null,
      mimeType: null,
      body: null,
      error: null,
    });
  });

  on("Network.responseReceived", (p) => {
    const r = requests.get(p.requestId);
    if (!r) return;
    r.status = p.response.status;
    r.mimeType = p.response.mimeType;
  });

  on("Network.loadingFinished", async (p) => {
    const r = requests.get(p.requestId);
    if (!r) return;
    try {
      const b = await send("Network.getResponseBody", { requestId: p.requestId });
      r.body = (b.base64Encoded ? Buffer.from(b.body, "base64").toString("utf8") : b.body).slice(0, 3000);
    } catch (e) {
      r.bodyError = e.message;
    }
  });

  on("Network.loadingFailed", (p) => {
    const r = requests.get(p.requestId);
    if (r) r.error = p.errorText;
  });

  return {
    toasts: new Set(),
    snapshot() {
      return [...requests.values()].map((r) => {
        let errCode = null;
        let errMsg = null;
        let topErrCode = null;
        let topErrMsg = null;
        let baseResp = null;
        try {
          const j = JSON.parse(r.body || "{}");
          topErrCode = j.errCode ?? j.errcode ?? j.code ?? null;
          topErrMsg = j.errMsg ?? j.errmsg ?? j.message ?? null;
          baseResp = j?.data?.baseResp || null;
          // 关键：视频号接口常见「顶层 errCode=0，但 data.baseResp.errcode 才是真实错误」
          if (baseResp && baseResp.errcode != null) {
            errCode = baseResp.errcode;
            errMsg = baseResp.errmsg || topErrMsg || null;
          } else {
            errCode = topErrCode;
            errMsg = topErrMsg;
          }
        } catch {
          /* 非 JSON 响应，保留原文 */
        }
        return { ...r, errCode, errMsg, topErrCode, topErrMsg, baseResp };
      });
    },
  };
}

/** 收集页面上的 toast / 弹窗文字，辅助判断服务端拒绝原因 */
async function collectToasts(send, set) {
  try {
    const arr = await cdp.evaluate(send, `(() => {
      const roots = [document, document.querySelector("wujie-app")?.shadowRoot].filter(Boolean);
      const out = [];
      for (const root of roots) {
        for (const el of root.querySelectorAll('[class*=toast],[class*=Toast],[class*=dialog],[class*=Dialog]')) {
          if (el.closest(".comment-count")) continue;
          const st = getComputedStyle(el);
          if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) === 0) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 5 || r.height < 5) continue;
          const t = (el.innerText || "").replace(/\\s+/g, " ").trim();
          if (t && t.length <= 100 && !/条评论$/.test(t)) out.push(t);
        }
      }
      return [...new Set(out)].slice(0, 10);
    })()`);
    for (const t of arr || []) set.add(t);
  } catch {
    /* 忽略 */
  }
}

async function main() {
  const red = checkText(TEXT);
  if (red.length) {
    console.error("[策略拦截] 文案不合规：" + red.join(" / "));
    process.exitCode = 4;
    return;
  }

  const pages = await cdp.listPages(PORT);
  const page = pages.find((p) => p.type === "page" && p.url.includes("interaction/comment"));
  if (!page) throw new Error("当前不在评论管理页");

  const { send, on, close } = await cdp.attach(page.webSocketDebuggerUrl);
  const log = { name: NAME, kw: KW, text: TEXT, dry: DRY, steps: [] };
  try {
    if (!(await cdp.ensureVisible(send))) throw new Error("页面不可见（懒加载不会触发）");
    await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});

    const st0 = await cdp.evaluate(send, STATE);
    log.before = st0;
    console.log(`① 当前视频：${st0.video.title}｜${st0.video.time}｜共 ${st0.declared} 条`);
    if (EXPECT !== null && st0.declared !== Number(EXPECT)) {
      throw new Error(`评论计数不是预期的 ${EXPECT}（现在 ${st0.declared}），可能有并发变动，中止`);
    }

    // 定位（必要时逐屏找）
    let hit = await cdp.evaluate(send, LOCATE(NAME, KW));
    if (!hit || hit.found !== 1) {
      await cdp.evaluate(send, `(() => {
        const root = document.querySelector("wujie-app").shadowRoot;
        const box = root.querySelector(".feed-comment__wrp");
        if (box) box.scrollTop = 0;
      })()`);
      await sleep(500);
      for (let i = 0; i < 30; i++) {
        hit = await cdp.evaluate(send, LOCATE(NAME, KW));
        if (hit && hit.found === 1) break;
        const moved = await cdp.evaluate(send, `(() => {
          const root = document.querySelector("wujie-app").shadowRoot;
          const box = root.querySelector(".feed-comment__wrp");
          if (!box) return null;
          const b = box.scrollTop;
          box.scrollTop = b + Math.round(box.clientHeight * 0.9);
          return { b, a: Math.round(box.scrollTop) };
        })()`);
        await sleep(450);
        if (!moved || moved.b === moved.a) break;
      }
    }
    log.locate = hit;
    if (!hit || hit.found !== 1) throw new Error(`目标未唯一命中（命中 ${hit && hit.found} 条）`);

    // ── 防重复回复：先把该线程的折叠回复全部展开，再判断 ──
    // 折叠里的作者回复不在 DOM 中，只看初始渲染会漏判，导致同一条评论被回两次
    // （2026-10-28 实测：老余那条线程已有 10-27 的回复，因被折叠而漏看，重复发了一次）
    for (let round = 0; round < 6; round++) {
      if (!hit.loadMore) break;
      if (hit.loadMore.spinning) {
        await sleep(1500);
        hit = await cdp.evaluate(send, LOCATE(NAME, KW));
        if (!hit || hit.found !== 1) break;
        continue;
      }
      const before = (hit.replies || []).length;
      await cdp.clickAt(send, hit.loadMore.x, hit.loadMore.y);
      let grew = false;
      for (let i = 0; i < 16; i++) {
        await sleep(500);
        const h2 = await cdp.evaluate(send, LOCATE(NAME, KW));
        if (h2 && h2.found === 1 && (h2.replies || []).length > before) {
          hit = h2;
          grew = true;
          break;
        }
        if (h2 && h2.found === 1) hit = h2;
      }
      if (!grew) break;
    }
    log.locateAfterExpand = hit;

    if (hit.authorReplied) {
      console.error("[策略拦截] 展开折叠后发现作者已回复过，按「只回一次」放弃");
      process.exitCode = 4;
      return;
    }
    // 第二道闸：线程里已存在与我们内容高度相同的话，也不再发
    {
      const flat = (s) => String(s || "").replace(/\s+/g, "");
      const head = flat(TEXT).slice(0, 8);
      const same = (hit.replies || []).find((r) => r.isAuthor && flat(r.text).includes(head));
      if (same) {
        console.error(`[策略拦截] 线程里已有相同内容：「${same.text.slice(0, 30)}」，不重复发`);
        process.exitCode = 4;
        return;
      }
    }
    console.log(`② 命中：${hit.item.name}｜${hit.item.time}｜${hit.item.text}`);

    await sleep(300);
    hit = await cdp.evaluate(send, LOCATE(NAME, KW));
    await cdp.clickAt(send, hit.x, hit.y);
    await cdp.waitFor(send, `(() => {
      const root = document.querySelector("wujie-app").shadowRoot;
      return !!(root && root.querySelector("textarea.create-input"));
    })()`, { timeout: 5000 }).catch(() => null);

    let panel = await cdp.evaluate(send, PANEL);
    log.panel0 = panel;
    if (!panel.textareas) throw new Error("回复面板没有出现");
    if (!(panel.placeholder || "").replace(/\s+/g, "").includes(String(NAME).replace(/\s+/g, ""))) {
      throw new Error(`面板归属不对：placeholder = ${panel.placeholder}，期望含「${NAME}」`);
    }
    if (!panel.send || panel.send.enabled) throw new Error("空输入时发送按钮竟然可用，中止");

    await cdp.clickAt(send, panel.ta.x, panel.ta.y);
    await sleep(150);
    await send("Input.insertText", { text: TEXT });
    await sleep(500);

    panel = await cdp.evaluate(send, PANEL);
    log.panel1 = panel;
    if (panel.value !== TEXT) throw new Error(`输入不一致：textarea = ${JSON.stringify(panel.value)}`);
    if (!panel.send || !panel.send.enabled) throw new Error("有文字但发送按钮未点亮，中止（可能不是真实键盘输入）");
    console.log(`③ 面板就绪：placeholder=${panel.placeholder}｜按钮=${panel.send.cls}`);

    if (DRY) {
      // dry：清空 + Esc 收起，不发送
      await cdp.evaluate(send, `(() => {
        const ta = document.querySelector("wujie-app").shadowRoot.querySelector("textarea.create-input");
        ta.focus(); ta.setSelectionRange(0, ta.value.length); return ta.value.length;
      })()`);
      for (let i = 0; i < TEXT.length + 2; i++) {
        await send("Input.dispatchKeyEvent", { type: "keyDown", code: "Backspace", key: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", code: "Backspace", key: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
      }
      // 收起面板用「取消」按钮：Esc 只在 textarea 有焦点时生效，清空后焦点可能已跑到宿主元素
      const cancel = await cdp.evaluate(send, `(() => {
        const root = document.querySelector("wujie-app").shadowRoot;
        const ta = root.querySelector("textarea.create-input");
        const item = ta && ta.closest(".comment-item");
        const btn = item && [...item.querySelectorAll(".create-ft .tag-wrap")].find((b) => (b.innerText || "").trim() === "取消");
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      if (cancel) await cdp.clickAt(send, cancel.x, cancel.y);
      await sleep(300);
      // 坐标点击偶尔会落空；补一次 DOM 点击取消，避免残留面板影响下一条
      const left = await cdp.evaluate(send, `(() => {
        const root = document.querySelector("wujie-app").shadowRoot;
        return root.querySelectorAll("textarea.create-input").length;
      })()`);
      if (left) {
        await cdp.evaluate(send, `(() => {
          const root = document.querySelector("wujie-app").shadowRoot;
          let n = 0;
          for (const ta of root.querySelectorAll("textarea.create-input")) {
            const item = ta.closest(".comment-item");
            const btn = item && [...item.querySelectorAll(".create-ft .tag-wrap")]
              .find((b) => (b.innerText || "").trim() === "取消");
            if (btn) { btn.click(); n++; }
          }
          return n;
        })()`);
        await sleep(250);
      }
      log.after = await cdp.evaluate(send, STATE);
      console.log("④ dry 结束，未发送。textarea =", log.after.textareas, "｜计数 =", log.after.declared);
    } else {
      const trace = startTrace(send, on);
      await send("Network.enable", {}).catch(() => {});

      const sent = await clickSend(send);
      log.sendClick = sent;
      console.log("④ 已点击「评论」，等结果…");

      let v = null;
      let reclicked = false;
      const clickedAt = Date.now();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await sleep(600);
        await collectToasts(send, trace.toasts);
        v = await cdp.evaluate(send, VERIFY(NAME, KW, TEXT));
        log.verify = v;
        if (v && v.declared === st0.declared + 1 && v.hit) break;

        // 面板还开着、文案还在、计数没动 → 第一次点击没生效（坐标漂移/被遮挡），补点一次
        if (!reclicked && Date.now() - clickedAt > 1800 &&
            v && v.declared === st0.declared && v.textareas > 0) {
          const p2 = await cdp.evaluate(send, PANEL);
          if (p2 && p2.send && p2.send.enabled && p2.value === TEXT) {
            const sent2 = await clickSend(send);
            log.reclickSend = sent2;
            reclicked = true;
            log.reclicked = true;
            console.log("   ↻ 面板仍在、计数未变，补点一次发送");
          }
        }
      }

      // 等响应体落地，再收口
      await sleep(600);
      await collectToasts(send, trace.toasts);
      const traceSnap = trace.snapshot();
      log.trace = { requests: traceSnap, toasts: [...trace.toasts] };
      await send("Network.disable", {}).catch(() => {});

      console.log("⑤ 三信号：", JSON.stringify(v));
      if (!traceSnap.length) {
        console.log("⑦ 发送链路：没有捕获到 comment 写请求（点击可能未触发接口）");
      } else {
        for (const r of traceSnap) {
          const extra = [
            r.status != null ? `HTTP ${r.status}` : "HTTP ?",
            r.errCode != null ? `errCode=${r.errCode}` : null,
            r.errMsg ? `errMsg=${r.errMsg}` : null,
            r.error ? `error=${r.error}` : null,
          ].filter(Boolean).join(" ");
          console.log(`⑦ 发送链路：${extra}｜${r.url.split("?")[0]}`);
        }
      }
      if (log.trace.toasts.length) {
        console.log("⑧ 页面提示：" + log.trace.toasts.join(" ｜ "));
      }

      const countUp = v && v.declared === st0.declared + 1;
      const threadHit = v && v.hit;
      const taZero = v && v.textareas === 0;
      log.result = { countUp, threadHit, taZero, declared: v && v.declared };

      if (countUp && threadHit) {
        console.log(`✓ 回复成功：${st0.declared} → ${v.declared}${taZero ? "" : "（面板未自动关闭）"}`);
        if (LIKE) {
          await sleep(2500);
          const lk = await likeTarget(send, NAME, KW);
          log.like = lk;
          console.log(lk.ok ? (lk.already ? "⑥ 已是红赞，跳过" : "⑥ 已点赞 ✓") : `⑥ 点赞失败：${lk.reason}`);
        }
      } else if (!countUp && taZero) {
        const code = traceSnap.find((r) => r.errCode != null && Number(r.errCode) !== 0);
        const known = { "-4010": "平台临时限制，功能暂不可用" };
        const detail = code
          ? `errCode=${code.errCode}${code.errMsg ? `，${code.errMsg}` : ""}${
              known[String(code.errCode)] ? `（${known[String(code.errCode)]}）` : ""
            }`
          : "未捕获错误码，见 trace";
        console.error(`✗ 服务端拒绝：计数未 +1、面板已关（${detail}）`);
        if (known[String(code?.errCode)]) {
          console.error("  → 这不是文案问题，是平台临时限制；不要连续重试，等限制解除后再补。");
        }
        process.exitCode = 5;
      } else {
        console.error("✗ 三信号未齐：可能是被吞或未生效，需重载复核后再决定");
        process.exitCode = 1;
      }
    }

    if (OUT) {
      const dir = path.dirname(OUT);
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(log, null, 2), "utf8");
      console.log("记录：" + OUT);
    }
  } finally {
    close();
  }
}

main().catch((e) => {
  console.error("[失败] " + (e.message || e));
  process.exitCode = 1;
});
