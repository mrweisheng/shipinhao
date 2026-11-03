#!/usr/bin/env node
/**
 * probe-reply-panel.js — 只探查「回复面板」，绝不发送
 *
 * 干什么：
 *   1. 粗查当前详情区是哪条视频（标题 + 发布时间）
 *   2. 按「昵称片段 + 内容关键词」在评论区里找到目标一级评论（不依赖时间戳）
 *   3. 真实鼠标点击回复气泡 `.action-icon.weui-icon-outlined-comment`
 *   4. 等 `textarea.create-input` 出现，记录面板结构 / placeholder / 发送按钮状态
 *   5. 真实键盘输入一段测试文字（Input.insertText），再读 textarea.value 与发送按钮是否变 primary
 *   6. 截图留证
 *   7. 清空输入 → Esc / 「取消」关面板 → 复核 textarea 数量归零
 *
 * 全程不点发送按钮。
 *
 * 用法：
 *   node scripts/probe-reply-panel.js --name 健文 --kw 订购一台白色
 *   node scripts/probe-reply-panel.js --name 健文 --kw 订购一台白色 --text "測試輸入"
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
const TEXT = getArg("text", "測試輸入");
const OUTDIR = path.join(__dirname, "..", "data", "probe");

if (!NAME || !KW) {
  console.error("需要 --name 昵称片段 --kw 内容关键词");
  process.exit(1);
}

const ROOT = `(() => {
  const host = document.querySelector("wujie-app");
  return host && host.shadowRoot ? host.shadowRoot : null;
})()`;

/** 当前详情区视频信息 + 评论计数 + textarea 数 */
const STATE = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return { error: "wujie shadow root 不存在" };
  const sel = root.querySelector(".feed-selected-info");
  const t = sel && sel.querySelector(".feed-title");
  const tm = sel && sel.querySelector(".feed-time");
  const tips = root.querySelector(".comment-count__tips");
  const box = root.querySelector(".feed-comment__wrp");
  return {
    video: {
      title: t ? (t.innerText || "").replace(/\\s+/g, " ").trim() : null,
      time: tm ? (tm.innerText || "").replace(/\\s+/g, " ").trim() : null,
    },
    countTips: tips ? (tips.innerText || "").replace(/\\s+/g, " ").trim() : null,
    rendered: root.querySelectorAll(".comment-item").length,
    textareas: root.querySelectorAll("textarea.create-input").length,
    scrollTop: box ? Math.round(box.scrollTop) : null,
    scrollHeight: box ? Math.round(box.scrollHeight) : null,
    clientHeight: box ? Math.round(box.clientHeight) : null,
  };
})()`;

/** 找到目标一级评论并滚到视口中间；返回回复气泡的坐标 */
const LOCATE = (name, kw) => `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return { error: "wujie shadow root 不存在" };
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const items = [...root.querySelectorAll(".comment-item")].filter((el) => !el.closest(".comment-reply-list"));
  const hits = [];
  for (const el of items) {
    const n = el.querySelector(".comment-user-name");
    const c = el.querySelector(".comment-content");
    const nameOk = n && norm(n.innerText).includes(${JSON.stringify(name)});
    const kwOk = c && norm(c.innerText).includes(${JSON.stringify(kw)});
    if (nameOk && kwOk) hits.push(el);
  }
  if (hits.length !== 1) {
    return {
      found: hits.length,
      candidates: items.map((el) => ({
        name: norm(el.querySelector(".comment-user-name")?.innerText || ""),
        text: norm(el.querySelector(".comment-content")?.innerText || "").slice(0, 40),
        time: norm(el.querySelector(".comment-time")?.innerText || ""),
      })).filter((x) => x.name.includes(${JSON.stringify(name)}) || x.text.includes(${JSON.stringify(kw)})),
    };
  }
  const el = hits[0];
  el.scrollIntoView({ block: "center" });
  const btn = el.querySelector(".action-icon.weui-icon-outlined-comment");
  if (!btn) return { found: 1, error: "NO_REPLY_BTN" };
  const r = btn.getBoundingClientRect();
  const ir = el.getBoundingClientRect();
  return {
    found: 1,
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    btn: { w: Math.round(r.width), h: Math.round(r.height), cls: String(btn.className) },
    item: {
      top: Math.round(ir.top),
      height: Math.round(ir.height),
      name: norm(el.querySelector(".comment-user-name")?.innerText || ""),
      time: norm(el.querySelector(".comment-time")?.innerText || ""),
      text: norm(el.querySelector(".comment-content")?.innerText || ""),
      isAuthor: norm(el.querySelector(".comment-row")?.innerText || "").includes("作者"),
      replies: el.querySelectorAll(".comment-reply-list .comment-item").length,
    },
  };
})()`;

/** 面板结构 + 输入框 + 发送按钮状态 */
const PANEL = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return { error: "wujie shadow root 不存在" };
  const tas = [...root.querySelectorAll("textarea.create-input")];
  if (!tas.length) return { textareas: 0 };
  const ta = tas[0];
  const item = ta.closest(".comment-item");
  const ft = item && item.querySelector(".create-ft");
  const btns = ft ? [...ft.querySelectorAll(".tag-wrap")] : [];
  const tr = ta.getBoundingClientRect();
  return {
    textareas: tas.length,
    taInsideTargetItem: !!item,
    ta: {
      placeholder: ta.getAttribute("placeholder"),
      value: ta.value,
      disabled: ta.disabled,
      maxlength: ta.getAttribute("maxlength"),
      x: Math.round(tr.left + tr.width / 2),
      y: Math.round(tr.top + tr.height / 2),
      w: Math.round(tr.width),
      h: Math.round(tr.height),
    },
    sendButtons: btns.map((b) => ({
      text: (b.innerText || "").replace(/\\s+/g, " ").trim(),
      cls: String(b.className),
      disabled: b.getAttribute("disabled") !== null || /disabled|grey|gray/i.test(String(b.className)),
      w: Math.round(b.getBoundingClientRect().width),
      h: Math.round(b.getBoundingClientRect().height),
    })),
    ftHTML: ft ? ft.outerHTML.replace(/\\s+/g, " ").slice(0, 600) : null,
    panelHTML: item ? item.outerHTML.replace(/\\s+/g, " ").slice(0, 900) : null,
  };
})()`;

/** 清空输入框（真实键盘：全选 + Backspace） */
const CLEAR_OR_FOCUS = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  const ta = root && root.querySelector("textarea.create-input");
  if (!ta) return { focused: false };
  ta.focus();
  ta.setSelectionRange(0, ta.value.length);
  return { focused: true, len: ta.value.length };
})()`;

async function key(send, type, code, keyCode, keyStr) {
  await send("Input.dispatchKeyEvent", {
    type,
    code,
    key: keyStr,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
}

async function main() {
  const pages = await cdp.listPages(PORT);
  const page = pages.find((p) => p.type === "page" && p.url.includes("interaction/comment"));
  if (!page) throw new Error("当前不在评论管理页（interaction/comment）");

  const { send, close } = await cdp.attach(page.webSocketDebuggerUrl);
  const log = {};
  try {
    if (!(await cdp.ensureVisible(send))) throw new Error("页面不可见（窗口被最小化/后台）");
    await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});

    log.state0 = await cdp.evaluate(send, STATE);
    console.log("① 当前状态：", JSON.stringify(log.state0));

    // 目标可能不在当前一屏（虚拟滚动）：从顶部逐屏找
    let hit = await cdp.evaluate(send, LOCATE(NAME, KW));
    if (!hit || hit.found !== 1) {
      console.log("② 当前屏没找到，从头逐屏搜索…");
      await cdp.evaluate(send, `(() => {
        const host = document.querySelector("wujie-app");
        const root = host && host.shadowRoot;
        const box = root && root.querySelector(".feed-comment__wrp");
        if (box) box.scrollTop = 0;
        return box ? box.scrollTop : null;
      })()`);
      await cdp.sleep(600);
      for (let i = 0; i < 30; i++) {
        hit = await cdp.evaluate(send, LOCATE(NAME, KW));
        if (hit && hit.found === 1) break;
        const moved = await cdp.evaluate(send, `(() => {
          const host = document.querySelector("wujie-app");
          const root = host && host.shadowRoot;
          const box = root && root.querySelector(".feed-comment__wrp");
          if (!box) return null;
          const before = box.scrollTop;
          box.scrollTop = before + Math.round(box.clientHeight * 0.9);
          return { before, after: Math.round(box.scrollTop), h: Math.round(box.scrollHeight) };
        })()`);
        await cdp.sleep(500);
        if (!moved || moved.before === moved.after) break;
      }
    }
    log.locate = hit;
    console.log("② 定位结果：", JSON.stringify(hit));
    if (!hit || hit.found !== 1) throw new Error("目标评论未唯一命中");

    await cdp.sleep(400);
    // 滚动后再量一次坐标（scrollIntoView 后布局可能微调）
    hit = await cdp.evaluate(send, LOCATE(NAME, KW));
    log.locate2 = hit;
    console.log("③ 点击回复气泡：", hit.x, hit.y);
    await cdp.clickAt(send, hit.x, hit.y);

    await cdp.waitFor(send, `(() => {
      const host = document.querySelector("wujie-app");
      const root = host && host.shadowRoot;
      return !!(root && root.querySelector("textarea.create-input"));
    })()`, { timeout: 5000 }).catch(() => null);

    log.panel0 = await cdp.evaluate(send, PANEL);
    console.log("④ 面板（输入前）：", JSON.stringify(log.panel0, null, 2));

    if (!log.panel0 || !log.panel0.textareas) throw new Error("回复面板未出现（textarea.create-input = 0）");

    // 真实点击输入框 → 真实键盘输入
    await cdp.clickAt(send, log.panel0.ta.x, log.panel0.ta.y);
    await cdp.sleep(200);
    await send("Input.insertText", { text: TEXT });
    await cdp.sleep(500);

    log.panel1 = await cdp.evaluate(send, PANEL);
    console.log("⑤ 面板（输入后）：", JSON.stringify(log.panel1, null, 2));

    if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });
    const shot = path.join(OUTDIR, `reply-panel-${Date.now()}.png`);
    const s = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(shot, Buffer.from(s.data, "base64"));
    log.screenshot = shot;
    console.log("⑥ 截图：", shot);

    // 清空并关面板：Esc 优先，失败再看「取消」
    const c = await cdp.evaluate(send, CLEAR_OR_FOCUS);
    if (c && c.focused) {
      for (let i = 0; i < 3; i++) {
        await key(send, "keyDown", "Backspace", 8, "Backspace");
        await key(send, "keyUp", "Backspace", 8, "Backspace");
        await cdp.sleep(80);
      }
    }
    await cdp.sleep(200);
    log.afterClear = await cdp.evaluate(send, PANEL);
    console.log("⑦ 清空后：", JSON.stringify(log.afterClear && log.afterClear.ta ? log.afterClear.ta.value : log.afterClear));

    await key(send, "keyDown", "Escape", 27, "Escape");
    await key(send, "keyUp", "Escape", 27, "Escape");
    await cdp.sleep(400);
    log.afterEsc = await cdp.evaluate(send, STATE);

    if (log.afterEsc.textareas > 0) {
      // Esc 不管用：找面板里的「取消」按钮点掉
      const cancel = await cdp.evaluate(send, `(() => {
        const host = document.querySelector("wujie-app");
        const root = host && host.shadowRoot;
        const ta = root && root.querySelector("textarea.create-input");
        const item = ta && ta.closest(".comment-item");
        if (!item) return null;
        for (const el of item.querySelectorAll(".create-ft *")) {
          if ((el.innerText || "").trim() === "取消") {
            const r = el.getBoundingClientRect();
            if (r.width > 4 && r.height > 4) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
        }
        return null;
      })()`);
      log.cancelBtn = cancel;
      if (cancel) {
        await cdp.clickAt(send, cancel.x, cancel.y);
        await cdp.sleep(400);
      }
      log.afterCancel = await cdp.evaluate(send, STATE);
    }

    console.log("⑧ 关面板后：", JSON.stringify(log.afterCancel || log.afterEsc));

    const outFile = path.join(OUTDIR, `reply-panel-${Date.now()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(log, null, 2), "utf8");
    console.log("⑨ 记录：", outFile);
  } finally {
    close();
  }
}

main().catch((e) => {
  console.error("[失败] " + (e.message || e));
  process.exitCode = 1;
});
