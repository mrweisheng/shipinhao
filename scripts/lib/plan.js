/**
 * lib/plan.js — 批量维护的「计划」格式与安全校验（不含任何业务关键词）
 *
 * 分工：
 *   模型（LLM）读评论 → 按 业务事实.md + SKILL + 案例库做语义判断 → 产出 plan JSON
 *   脚本            → 逐条校验（禁词/长度/表情/引导数/重复）→ 调 08 发送 → 核验 → 记录
 *
 * 这样换账号、换业务、换说法都不用改脚本；规则只改 业务事实.md / SKILL / data/cases。
 */

const fs = require("fs");

/** 公开区绝对不出现的词（与 08 的关卡一致；头像/简介/私讯/置顶允许） */
const BANNED = [
  "微信", "vx", "wechat", "電話", "电话", "手機", "手机", "加我",
  "二維碼", "二维码", "號碼", "号码",
  "聯繫方式", "联系方式", "聯絡方式", "联络方式",
  "私信",  // 简体；繁体「私訊」允许
  "唔方便喺度講", "唔方便喺度讲", "私下講", "私下讲",
];

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF\uFE0F]/u;

/** 引导路径：一条回复只能走一条（「睇簡介」属于头像路径，不单算） */
const PATH_DEFS = [
  ["頭像", /頭像|头像/],
  ["PM", /\bPM\b/i],
  ["私訊", /私訊/],
  ["置頂", /置頂|置顶|🔝|頂部|顶部/],
  ["主頁", /主頁|主页/],
];
function guidePaths(text) {
  const s = String(text || "");
  const set = new Set();
  for (const [k, re] of PATH_DEFS) if (re.test(s)) set.add(k);
  return [...set];
}

/** 软邀请：和引导同时出现就是双 CTA（2026-10-23「過嚟傾下先，頭像搵明哥」） */
const SOFT_INVITE = /過嚟|過黎|上嚟|嚟傾|搵我傾|搵明哥傾|傾下先|過來/;

/** 文案硬校验：返回问题数组，空数组代表可发 */
function checkText(t) {
  const errs = [];
  const low = String(t || "").toLowerCase();
  const hits = BANNED.filter((w) => low.includes(w.toLowerCase()));
  if (hits.length) errs.push(`禁词：${hits.join(" / ")}`);

  // 单路径铁律：点头像 + PM/私訊 = 两个动作，用户会觉得在硬拉客
  const paths = guidePaths(t);
  if (paths.length > 1) {
    errs.push(`引导路径叠加（${paths.join(" + ")}）：一条回复只走一条路径，别又点头像又 PM／私訊`);
  }
  if (paths.length && SOFT_INVITE.test(String(t))) {
    errs.push("软邀请 + 引导 = 双 CTA（如「過嚟傾下先，頭像搵明哥」）：只保留一个动作");
  }

  // 报价口径：指路，不自评、不喊口号（2026-10-30）
  if (/價錢公道|公道|實惠|最抵|明碼實價|一車一價/.test(String(t))) {
    errs.push("自评价格 / 喊口号（公道／實惠／最抵／明碼實價／一車一價）：改用「{對象}明細，點頭像👤搵明哥」");
  }

  const len = [...String(t).replace(/\s/g, "")].length;
  if (len > 22) errs.push(`长度 ${len} 字（上限 22）`);
  if (!EMOJI_RE.test(String(t))) errs.push("缺少表情");

  if (/保证|包搞掂|包搞定|一定得|最低價|最低价|全港最平|實時行情|实时行情/.test(String(t))) {
    errs.push("含承诺/绝对化表述");
  }
  return errs;
}

/** 评论正文 → 定位关键词（给 08 的 --kw 用；优先用计划里手填的 kw） */
function keywordOf(text) {
  const s = String(text || "").replace(/\s+/g, "");
  const cleaned = s
    .replace(/\[[^\]]{0,24}\]/g, "")
    .replace(/[/:][a-z]+/gi, "")
    .trim();
  // 取最长的一段连续「汉字/字母/数字」，避免关键词跨标点导致 includes 匹配失败
  const runs = cleaned.match(/[\p{Script=Han}A-Za-z0-9]+/gu) || [];
  const base = runs.length ? runs.reduce((a, b) => (b.length > a.length ? b : a)) : cleaned;
  const pick = base || s;
  return pick.slice(0, 6) || s.slice(0, 6);
}

/** 从标题提取固定标价（只用于给模型参考，不参与判断） */
function detectPrice(title) {
  const t = String(title || "").replace(/[,，\s]/g, "");
  let m = t.match(/(\d+(?:\.\d+)?)([万萬])(\d)?/);
  if (m) return m[1] + "萬" + (m[3] || "");
  m = t.match(/(\d{2,6})(?:元|蚊|港幣|港币|hkd)/i);
  if (m) return m[1] + "元";
  return null;
}

const PORTS = ["蓮塘", "莲塘", "深圳灣", "深圳湾", "港珠澳", "皇崗", "皇岗", "文錦渡", "文锦渡", "沙頭角", "沙头角", "落馬洲", "落马洲"];
const MODELS = ["埃爾法", "埃尔法", "阿爾法", "阿尔法", "賓利", "宾利", "奔馳", "奔驰", "寶馬", "宝马", "奧迪", "奥迪", "GLE", "特斯拉", "Tesla", "豐田", "丰田", "本田", "日產", "日产"];

/**
 * 标题上下文：车型 / 口岸 / 业务线 / 标价。
 * 只作为起草参考，绝不用于判断某条评论「该不该回」。
 * 方言标题看不懂很正常，评论本身是正向咨询就必须回。
 */
function detectContext(title) {
  const t = String(title || "");
  // 话题标签（#...）只作辅助，不参与业务线判断；否则每条带 #两地牌 的视频都会变成“两地牌”
  const main = t.split("#")[0];
  const ports = PORTS.filter((p) => t.includes(p));
  const models = MODELS.filter((m) => t.toLowerCase().includes(m.toLowerCase()));
  let business = "unknown";
  if (/兩地牌|两地牌|中港牌|港車北上|港车北上|口岸|指標|指标/.test(main)) business = "plate";
  else if (/移民|高才|優才|优才|身份|簽證|签证|移居/.test(main)) business = "immigration";
  else if (/車|车|埃爾法|埃尔法|阿爾法|阿尔法|賓利|宾利|奔馳|奔驰|GLE|寶馬|宝马/.test(main)) business = "car";
  return { business, ports, models, price: detectPrice(t) };
}

/**
 * 校验整份计划。
 * 必填：items[].index / name / action
 * action=reply 时必填 text；kw 可省略（由 content 自动生成）
 */
const GUIDE = {
  私訊: /私訊/,
  PM: /\bPM\b/i,
  頭像: /頭像/,
  簡介: /簡介/,
  置頂: /置頂/,
  主頁: /主頁/,
};

/** 这条回复走的是哪条引导路径（没引导返回 null） */
function guidePath(text) {
  const t = String(text || "");
  const hits = Object.keys(GUIDE).filter((k) => GUIDE[k].test(t));
  if (!hits.length) return null;
  // 组合路径（如「點頭像👤，PM 我」）按“最具体出口”归一，否则连续检测会被组合写法打断
  const ORDER = ["私訊", "PM", "置頂", "主頁", "頭像", "簡介"];
  return ORDER.find((k) => hits.includes(k)) || hits[0];
}

/**
 * 批次级检查：防止「清一色同一句式」。
 * 单条合规 ≠ 整批安全：连续多条都用同一个私域词收尾、句句一个模子，
 * 平台侧看到的是「批量营销话术」，会被折叠/限流（2026-10-27 实测 私訊 密度 56%）。
 *
 * 2026-10-30 改：
 *  - 分母改「滚动 7 天」（含 history）；单批 <5 条不算占比，避免 1 条求联系 = 100% 的误伤。
 *  - 新增「带引导占比」闸门（整批清一色导流，比单个词更危险）。
 *  - 私訊 从「≤40%」降为受限词（目标 ≤15%）；PM 成为默认英文出口（≤20%）。
 *  - 连续同路径：2 条为上限（第 3 条即拒）。
 *  - DM 不用（中文语境指 IG/小红书私信，有引导站外联想），出现即提醒。
 */
const WINDOW = 7 * 24 * 3600 * 1000;

function windowReplies(replies, history, now) {
  const from = now - WINDOW;
  const hist = (history || [])
    .filter((h) => h && h.text && (!h.at || !Number.isFinite(Date.parse(h.at)) || Date.parse(h.at) > from))
    .map((h) => ({ text: String(h.text) }));
  return hist.concat(replies);
}

function checkBatch(items, opt = {}) {
  const errors = [];
  const warnings = [];
  const replies = items.filter((x) => x.action === "reply" && x.text);
  const now = opt.now || Date.now();
  const all = windowReplies(replies, opt.history, now);
  if (!all.length) return { errors, warnings };

  // 单批 <5 条且历史也不足 5 条时，占比没有统计意义，只查连续路径
  const ratioOk = all.length >= 5;
  const pct = (n, d) => Math.round((n / d) * 100);

  // 1. 带引导占比（整批清一色导流）
  if (ratioOk) {
    const guided = all.filter((x) => guidePath(x.text)).length;
    const r = guided / all.length;
    if (r > 0.6) {
      errors.push(
        `近 7 天 ${guided}/${all.length} 条回复带引导（${pct(guided, all.length)}%），超过 60% —— 整批像营销话术；改为直接答事实（地址/时间/车况/库存）`
      );
    } else if (r > 0.4) {
      warnings.push(`近 7 天带引导占比 ${pct(guided, all.length)}%（${guided}/${all.length}），目标 ≤40%`);
    }
  }

  // 2. 单一私域词（私訊 为受限词；PM 为默认英文出口，各有上限）
  const LIMITS = [
    { word: "私訊", warn: 0.15, deny: 0.3, hint: "改用點頭像／PM，私訊只留给确实要私信的场景" },
    { word: "PM", warn: 0.2, deny: 0.35, hint: "换一部分为頭像／置頂／直接答" },
  ];
  for (const { word, warn, deny, hint } of LIMITS) {
    if (!ratioOk) break;
    const n = all.filter((x) => GUIDE[word].test(String(x.text))).length;
    const r = n / all.length;
    if (r > deny) {
      errors.push(
        `近 7 天「${word}」出现在 ${n}/${all.length} 条回复里（${pct(n, all.length)}%），超过 ${Math.round(
          deny * 100
        )}% —— ${hint}`
      );
    } else if (r > warn) {
      warnings.push(`近 7 天「${word}」占比 ${pct(n, all.length)}%（${n}/${all.length}），目标 ≤${Math.round(warn * 100)}%`);
    }
  }

  // 3. 连续同路径（跨批次边界也算；只报触及本批的连续段）
  const start = all.length - replies.length;
  let run = 1;
  let worst = 0;
  let worstPath = null;
  let worstTouchesBatch = false;
  for (let i = 1; i < all.length; i++) {
    const a = guidePath(all[i - 1].text);
    const b = guidePath(all[i].text);
    if (a && a === b) {
      run++;
      if (run > worst) {
        worst = run;
        worstPath = b;
        worstTouchesBatch = i >= start;
      }
    } else {
      run = 1;
    }
  }
  if (worstTouchesBatch && worst >= 3) {
    errors.push(`连续 ${worst} 条都用「${worstPath}」引导（含最近 7 天），必须中间插一条直接答事实的`);
  } else if (worstTouchesBatch && worst === 2) {
    warnings.push(`连续 2 条都用「${worstPath}」引导，下一条必须换路径`);
  }

  // 4. DM 不用（2026-10-30）
  for (const x of replies) {
    if (/\bDM\b/i.test(String(x.text))) {
      warnings.push(`「${x.text}」用了 DM：中文语境常指 IG / 小红书私信，有引导站外联想，改用 PM 我`);
    }
  }

  // 5. 指路句式别形成新的清一色（2026-10-30）
  const POINTER = /明細|詳情|細節|內容/;
  const ptr = replies.filter((x) => POINTER.test(String(x.text))).length;
  if (replies.length >= 5 && ptr / replies.length > 0.6) {
    warnings.push(
      `本批 ${ptr}/${replies.length} 条都用「明細／詳情」指路（${Math.round((ptr / replies.length) * 100)}%），换几条直接答事实或纯捧场`
    );
  }

  return { errors, warnings };
}

function validatePlan(plan, opt = {}) {
  const errors = [];
  const warnings = [];

  if (!plan || typeof plan !== "object") return { ok: false, errors: ["计划不是对象"], warnings };
  if (!Array.isArray(plan.items)) return { ok: false, errors: ["缺少 items 数组"], warnings };

  const seen = new Set();
  for (const [i, x] of plan.items.entries()) {
    const at = `items[${i}]`;
    if (x.index === undefined || x.index === null) errors.push(`${at} 缺少 index`);
    if (!x.name) errors.push(`${at} 缺少 name`);
    if (x.action !== "reply" && x.action !== "skip") {
      errors.push(`${at} action 必须是 reply 或 skip（现在是 ${JSON.stringify(x.action)}）`);
      continue;
    }

    const key = `${x.index}|${x.name}`;
    if (seen.has(key)) errors.push(`${at} 重复：${key}`);
    seen.add(key);

    if (x.action === "reply") {
      if (!x.asked || !String(x.asked).trim()) {
        errors.push(`${at}（${x.name}）缺少 asked：先用一句话复述客户在问什么`);
      }
      if (x.answerOk !== true) {
        errors.push(`${at}（${x.name}）answerOk 必须为 true：确认正文（去掉引导）直接回答了 asked`);
      }
      if (!x.text || !String(x.text).trim()) {
        errors.push(`${at}（${x.name}）回复缺少 text`);
        continue;
      }
      for (const e of checkText(x.text)) errors.push(`${at}（${x.name}）${e}`);
      if (!x.kw && !x.content) warnings.push(`${at}（${x.name}）没有 kw/content，靠昵称定位可能不唯一`);
    } else if (!x.reason) {
      warnings.push(`${at}（${x.name}）跳过但没写 reason`);
    }
  }

  const batch = checkBatch(plan.items, { history: opt.history, now: opt.now });
  errors.push(...batch.errors);
  warnings.push(...batch.warnings);

  return { ok: errors.length === 0, errors, warnings };
}

/** 重复文案检查：最近 3 条内完全相同 → 阻断；7 天内用过 → 提醒 */
function checkDuplicates(plan, history) {
  const recent = (history || []).slice(-3).map((h) => h.text);
  const week = Date.now() - 7 * 24 * 3600 * 1000;
  const usedWeek = new Set(
    (history || []).filter((h) => Date.parse(h.at || 0) > week).map((h) => h.text)
  );

  const errors = [];
  const warnings = [];
  let prev = null;
  for (const x of plan.items) {
    if (x.action !== "reply") continue;
    if (recent.includes(x.text)) errors.push(`与最近发送的文案完全相同：${x.text}`);
    else if (usedWeek.has(x.text)) warnings.push(`7 天内用过同一句：${x.text}`);
    if (prev === x.text) errors.push(`计划内相邻两条文案相同：${x.text}`);
    prev = x.text;
  }
  return { errors, warnings };
}

function load(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text);
}

module.exports = { BANNED, checkText, guidePaths, keywordOf, detectPrice, detectContext, validatePlan, checkDuplicates, load };
