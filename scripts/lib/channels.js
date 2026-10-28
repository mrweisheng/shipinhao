/**
 * lib/channels.js — 视频号评论管理页的站点级助手
 *
 * 只放「与页面结构有关」的通用动作，不放任何账号/视频/评论内容：
 *   ensureVideoTab(send)      确保左侧列表停在「视频」tab（而不是「图文」）
 *   ensureListed(send, want)  把视频列表滚动加载到第 want 条（want=null 表示全部）
 *
 * 这两个动作是「读第 N 条评论」的前置条件，04 与 05 共用。
 */

const cdp = require("./cdp");

// ── tab：视频 / 图文 ──────────────────────────────────────
const TAB_STATE = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return null;
  const lis = [...root.querySelectorAll("li.weui-desktop-tab__nav")].filter((li) => {
    const t = (li.innerText || "").trim();
    return t === "视频" || t === "图文";
  });
  if (!lis.length) return { found: false, tabs: [], current: null };
  const cur = lis.find((li) => /nav_current/.test(li.className));
  return {
    found: true,
    tabs: lis.map((li) => ({ txt: (li.innerText || "").trim(), cur: /nav_current/.test(li.className) })),
    current: cur ? (cur.innerText || "").trim() : null,
  };
})()`;

const CLICK_VIDEO_TAB = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return null;
  const li = [...root.querySelectorAll("li.weui-desktop-tab__nav")].find(
    (x) => (x.innerText || "").trim() === "视频"
  );
  if (!li) return null;
  const r = li.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

/** 确保列表停在「视频」tab。找不到 tab 结构时返回 null（不阻断，交给调用方判断）。 */
async function ensureVideoTab(send) {
  let st = await cdp.evaluate(send, TAB_STATE);
  if (!st) return null;
  if (!st.found) return st;                    // 页面没有这个 tab（结构变动），不阻断
  if (st.current === "视频") return st;

  const pos = await cdp.evaluate(send, CLICK_VIDEO_TAB);
  if (!pos) return st;
  await cdp.clickAt(send, pos.x, pos.y);
  await cdp.sleep(800);

  st = await cdp.evaluate(send, TAB_STATE);
  return st;
}

// ── 视频列表：懒加载 ─────────────────────────────────────
const LIST_STATE = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return null;
  const nums = root.querySelector(".feeds-nums");
  const t = nums ? (nums.innerText || "").trim() : "";
  const m = t.match(/(\\d+)/);
  return {
    count: root.querySelectorAll(".comment-feed-wrap").length,
    declared: m ? Number(m[1]) : null,
    label: t || null,
  };
})()`;

// 回退一点，制造新的滚动位移：贴底后直接赋 scrollHeight 不产生 scroll 事件
const LIST_BACK = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return false;
  const first = root.querySelector(".comment-feed-wrap");
  if (!first) return false;
  let el = first.parentElement;
  while (el && el !== root) {
    if (el.scrollHeight > el.clientHeight + 20) {
      el.scrollTop = Math.max(0, el.scrollTop - 400);
      return true;
    }
    el = el.parentElement;
  }
  return false;
})()`;

const LIST_BOTTOM = `(() => {
  const host = document.querySelector("wujie-app");
  const root = host && host.shadowRoot;
  if (!root) return false;
  const first = root.querySelector(".comment-feed-wrap");
  if (!first) return false;
  let el = first.parentElement;
  while (el && el !== root) {
    if (el.scrollHeight > el.clientHeight + 20) {
      el.scrollTop = el.scrollHeight;
      return true;
    }
    el = el.parentElement;
  }
  return false;
})()`;

// 滚动容器位置 + 状态（诊断 & 发送滚轮事件用）
const LIST_DIAG = `(() => {
  const root = document.querySelector("wujie-app") && document.querySelector("wujie-app").shadowRoot;
  if (!root) return null;
  const first = root.querySelector(".comment-feed-wrap");
  const count = root.querySelectorAll(".comment-feed-wrap").length;
  let sc = first ? first.parentElement : null;
  while (sc && sc !== root && !(sc.scrollHeight > sc.clientHeight + 20)) sc = sc.parentElement;
  if (!sc || sc === root) return { count, vis: document.visibilityState, focus: document.hasFocus(), sc: null };
  const r = sc.getBoundingClientRect();
  return {
    count,
    vis: document.visibilityState,
    focus: document.hasFocus(),
    top: Math.round(sc.scrollTop),
    h: Math.round(sc.scrollHeight),
    ch: Math.round(sc.clientHeight),
    box: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
  };
})()`;

/**
 * 懒加载停住时的「唤醒」：
 *   1) 让页面以为自己在前台（窗口被遮挡时渲染/观察器可能被节流）
 *   2) 发真实滚轮事件（有些版本靠 wheel/scroll 事件而不是 IntersectionObserver）
 *   3) 再贴一次底
 */
async function wakeLazyLoad(send) {
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await send("Page.bringToFront").catch(() => {});

  const d = await cdp.evaluate(send, LIST_DIAG).catch(() => null);
  if (d && d.box) {
    for (let i = 0; i < 3; i++) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseWheel", x: d.box.x, y: d.box.y, deltaX: 0, deltaY: 1500, pointerType: "mouse",
      }).catch(() => {});
      await cdp.sleep(150);
    }
  }
  await cdp.evaluate(send, LIST_BACK).catch(() => {});
  await cdp.sleep(120);
  await cdp.evaluate(send, LIST_BOTTOM).catch(() => {});
  await cdp.sleep(300);
}

/**
 * 把视频列表滚到至少 want 条；want = null 表示滚到页面声明的全部。
 * 返回最终 { count, declared, label }。want 超过总数时抛错，不静默。
 */
async function ensureListed(send, want, { maxRounds = 120, label = "" } = {}) {
  // 先等列表渲染出来：03 刚跳转到评论页时，wujie 还在挂载，此刻是 0 条
  let st = null;
  const readyDeadline = Date.now() + 25000;
  while (Date.now() < readyDeadline) {
    st = await cdp.evaluate(send, LIST_STATE);
    if (st && (st.count > 0 || st.declared !== null)) break;
    await cdp.sleep(250);
  }
  if (!st) throw new Error("找不到视频列表（页面可能还没渲染完），请稍后重试");
  if (st.count === 0 && st.declared === null) {
    throw new Error("等待 25s 视频列表仍未渲染。可能页面结构变了，或当前不在评论管理页");
  }

  if (want !== null) {
    if (st.declared !== null && want > st.declared) {
      throw new Error(`列表只有 ${st.declared} 条，没有第 ${want} 条`);
    }
    if (st.count >= want) return st;
  } else if (st.declared !== null && st.count >= st.declared) {
    return st;
  }

  // 每批加载耗时并不固定：刚整页重载后可能 3~5s 才来一批。
  // 所以「停止」不能按空转轮数判断，而是按「距上次有新增长过了多久」判断。
  const target = want === null ? (st.declared ?? Infinity) : want;
  const pct = st.declared ? `/${st.declared}` : "";
  console.log(`${label}列表已渲染 ${st.count}${pct} 条，滚动加载到${target === Infinity ? "全部" : `第 ${target} 条`}…`);

  // 实测：真卡死时「唤醒」（滚轮 + 前台模拟）几乎无效，重载才有效。
  // 所以只给一次唤醒机会，12s + 6s 观察后就交给上层重载，别让用户干等 1 分钟。
  const STALL_MS = 12000;
  let lastGrowth = Date.now();
  let wakeCount = 0;

  for (let i = 0; i < maxRounds; i++) {
    const before = st.count;

    await cdp.evaluate(send, LIST_BACK);
    await cdp.sleep(120);
    const rolled = await cdp.evaluate(send, LIST_BOTTOM);
    if (!rolled) break;                        // 内容不够长，无需滚动

    // 自适应等待：一有新增就继续；最多等 6s（慢批次也不误判）
    let grew = false;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await cdp.sleep(120);
      const s2 = await cdp.evaluate(send, LIST_STATE);
      if (s2 && s2.count > before) { st = s2; grew = true; break; }
    }

    if (grew) {
      console.log(`  …已加载 ${st.count}${st.declared ? `/${st.declared}` : ""} 条`);
      lastGrowth = Date.now();
      wakeCount = 0;
    } else {
      const idle = Date.now() - lastGrowth;
      if (wakeCount >= 1) {
        // 唤醒后只再给 6s：真卡死时它不会恢复，早点交给上层重载
        if (idle > 6000) {
          console.log(`  ⚠ 唤醒后仍无新增（停在 ${st.count} 条）→ 判定卡死，交给重载`);
          break;
        }
      } else if (idle > STALL_MS) {
        const d = await cdp.evaluate(send, LIST_DIAG).catch(() => null);
        if (d) {
          console.log(
            `  ⚠ ${Math.round(idle / 1000)}s 无新增（可见性 ${d.vis}，焦点 ${d.focus}，` +
              `滚动 ${d.top}/${d.h}）→ 尝试唤醒一次…`
          );
        }
        wakeCount++;
        await wakeLazyLoad(send);
        lastGrowth = Date.now();
      }
    }

    if (st.count >= target) break;
    if (st.declared !== null && st.count >= st.declared) break;
  }

  if (want !== null && st.count < want) {
    throw new Error(
      `列表加载停在第 ${st.count} 条，未到第 ${want} 条` +
        (st.declared !== null ? `（页面声明共 ${st.declared} 条）` : "")
    );
  }
  return st;
}

/**
 * 重载评论页并等列表重新渲染。
 * 用于列表懒加载被静默卡住（请求没发出去 / 状态坏了）时的恢复。
 */
async function reloadList(send, { log = () => {}, timeout = 30000 } = {}) {
  log("重载评论页（刷新可清掉卡住的加载状态）…");
  await cdp.evaluate(send, "location.reload()").catch(() => {});
  await cdp.sleep(1200);

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const st = await cdp.evaluate(send, LIST_STATE).catch(() => null);
    if (st && (st.count > 0 || st.declared !== null)) {
      log(`  重载完成，列表 ${st.count}${st.declared ? `/${st.declared}` : ""} 条`);
      return st;
    }
    await cdp.sleep(400);
  }
  throw new Error("重载后 30s 列表仍未渲染");
}

/**
 * ensureListed + 自动恢复：
 * 列表滚到一半被静默卡住时（实测偶发），重载页面再从头滚一次。
 * 重载会回到列表顶部，但序号顺序不变，所以目标 N 依然有效。
 */
async function ensureListedWithRecovery(send, want, { attempts = 3, log = console.log, label = "" } = {}) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await ensureListed(send, want, { label: i === 1 ? label : `${label}[重试${i - 1}] ` });
    } catch (e) {
      lastErr = e;
      // 越界这类错误重试也没用，直接抛
      if (/没有第\s*\d+\s*条/.test(e.message)) throw e;
      if (i === attempts) break;
      log(`  ✗ ${e.message}`);
      try {
        await reloadList(send, { log });
        await ensureVideoTab(send);
      } catch (e2) {
        log(`  重载失败：${e2.message}`);
      }
    }
  }
  throw lastErr;
}

module.exports = { ensureVideoTab, ensureListed, ensureListedWithRecovery, reloadList, TAB_STATE, LIST_STATE };
