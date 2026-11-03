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

/** 公开区绝对不出现的词（与 08 的关卡一致；头像/简介/主页允许，私信类一律禁止） */
const BANNED = [
  "微信", "vx", "wechat", "電話", "电话", "手機", "手机", "加我",
  "二維碼", "二维码", "號碼", "号码",
  "聯繫方式", "联系方式", "聯絡方式", "联络方式",
  "唔方便喺度講", "唔方便喺度讲", "私下講", "私下讲",
];

/**
 * 🔴 私信/私聊类硬禁（2026-11-02 定版）
 * 评论区的价值是口碑与线索识别，不把人往私信赶：
 * 账号 2026-09-17 有「减少推荐和禁止私信 7 天」记录；2026-10-27 实测私訊密度 56% 被折叠。
 */
const PRIVATE_BAN = [
  [/私訊|私信|私聊|私我|私低|私下傾|私下倾/, "私信/私聊类引导"],
  [/\bPM\b/i, "PM（私信引导）"],
  [/\bDM\b/i, "DM（私信引导）"],
  [/置頂|置顶|🔝|頂部第一條|顶部第一条/, "置顶引导"],
  [/📩|💬/, "信封/对话框表情（暗示发私信）"],
];

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF\uFE0F]/u;

// 🔴 零联系动作（2026-11-03 定版）：评论区不出现任何「来找我」的动作。
// 点头像 / 主页 / 简介 / 搵明哥 全部禁止；地址、时间、导航属于公开信息，不受影响。
const POINTER_BAN = /點頭像|点头像|點開頭像|点开头像|主頁|主页|睇簡介|睇简介|搵明哥|搵我/;

/** 引导路径：一条回复只能走一条（「睇簡介」属于头像路径，不单算） */
const PATH_DEFS = [
  ["頭像", /頭像|头像|簡介|简介/],
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

  // 🔴 私信/私聊类一律禁止（2026-11-02）：私訊/私信/PM/DM/置頂/📩💬
  for (const [re, label] of PRIVATE_BAN) {
    if (re.test(low)) errs.push(`私信类禁用：${label}（改用直接答事实／地址时间）`);
  }

  // 🔴 零联系动作（2026-11-03）：点头像／主页／简介／搵明哥 全部不写
  if (POINTER_BAN.test(String(t))) {
    errs.push("零联系动作：不出现「點頭像／主頁／睇簡介／搵明哥」（直接答事实或到店睇）");
  }

  // 单路径铁律：一条回复只给一个动作
  const paths = guidePaths(t);
  if (paths.length > 1) {
    errs.push(`引导路径叠加（${paths.join(" + ")}）：一条回复只走一条路径，别又點頭像又主頁`);
  }
  if (paths.length && SOFT_INVITE.test(String(t))) {
    errs.push("软邀请 + 引导 = 双 CTA（如「過嚟傾下先，頭像搵明哥」）：只保留一个动作");
  }

  // 报价口径：指路，不自评、不喊口号（2026-10-30）
  if (/價錢公道|公道|實惠|最抵|明碼實價|一車一價/.test(String(t))) {
    errs.push("自评价格 / 喊口号（公道／實惠／最抵／明碼實價／一車一價）：改用「{對象}明細，點頭像👤搵明哥」");
  }

  // 不提费用（2026-10-31）：费用一出现就像报价，且拖进没口径的领域
  if (/費用|费用|收費|收费/.test(String(t))) {
    errs.push("出现「費用／收費」：问费用只承接+指路（明細／詳情／細節 + 點頭像），不报价、不解释构成");
  }

  // 评论区一律不报价（2026-11-01）：视频已标价也不报——评论可能问的是另一条视频的车
  // 先剔除非价格数字：年份、里程、排量/马力，避免把「2017年」「4萬5公里」当报价拦掉
  const noNum = String(t)
    .replace(/(?:19|20)\d{2}\s*年?/g, "")
    .replace(/\d+(?:\.\d+)?\s*[萬万]?\s*\d*\s*(?:公里|里數|里数|里程|km)/gi, "")
    .replace(/\d+(?:\.\d+)?\s*(?:cc|ml|l|升|匹|馬力|马力)/gi, "");
  const priceHit =
    /\d+(?:\.\d+)?\s*[萬万]/.test(noNum) ||
    /\d{3,}\s*(?:元|蚊|港幣|港币|hkd)/i.test(noNum) ||
    /\d{5,}/.test(noNum) ||
    /[一二三四五六七八九十]+\s*[萬万]\s*[一二三四五六七八九]?/.test(noNum);
  if (priceHit) {
    errs.push("出现价格数字：评论区一律不报价（含已标价，客户可能问的是另一条视频的车）；改「{對象}明細，點頭像👤搵明哥」");
  }

  // 免责话术（2026-10-31 用户否决）：像隐瞒、像不熟自己的车
  if (/以驗車報告為準|以验车报告为准|以實物為準|以实物为准|僅供參考|仅供参考|不作準|不作准/.test(String(t))) {
    errs.push("免责话术（以驗車報告為準／以實物為準／僅供參考）：参数问题统一「車輛明細，點頭像👤搵明哥，發俾你」");
  }

  // 参数不要拼「年份明細」（2026-10-31 定版）：参数不是商品，只有商品/方案才用「对象明細」
  if (/(年份|年款|里數|里数|里程|公里|排量|配置|過戶|过户|幾手|几手)明細/.test(String(t))) {
    errs.push("参数问题不要拼「年份明細／里數明細／排量明細」：统一「車輛明細，點頭像👤搵明哥」");
  }

  const len = [...String(t).replace(/\s/g, "")].length;
  if (len > 22) errs.push(`长度 ${len} 字（上限 22）`);
  if (!EMOJI_RE.test(String(t))) errs.push("缺少表情");

  // 表情位置（2026-11-03）：零联系动作后，只有残留「明細/詳情」这类指路词才要求表情在句中；
  // 普通答句（價錢嘅嘢，現場睇 😄）允许句尾。
  const noSpace = String(t).replace(/\s/g, "");
  const onlyEmoji = noSpace.length > 0 && [...noSpace].every((ch) => EMOJI_RE.test(ch));
  const chars = [...String(t).trim()];
  const hasPointer = /明細|明细/i.test(String(t));
  if (!onlyEmoji) {
    if (chars.length && EMOJI_RE.test(chars[0])) errs.push("表情不要放开头：放在文字中间（打断关键词）");
    if (hasPointer && chars.length && EMOJI_RE.test(chars[chars.length - 1])) {
      errs.push("指路句的表情不要放结尾：放句中或直接用 👤（👤 已算表情）");
    }
  }

  // 一条回复只一个动作：不要「搵明哥，發俾你」叠两个目的（2026-11-02）
  if (/(搵明哥|搵我|搵佢)[，,]\s*(發俾你|發你|傳你)/.test(String(t))) {
    errs.push("动作叠加（搵明哥 + 發俾你）：只留一个，「車輛明細，點頭像👤搵明哥」");
  }

  // 不要把参数问题推给验车报告（2026-10-31 用户否决）
  if (/睇驗車報告|睇报告|睇報告|報告最準|報告最准/.test(String(t))) {
    errs.push("免责/推给报告：参数问题统一「車輛嘅嘢，現場睇 😄」");
  }

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

const PORTS = ["蓮塘", "莲塘", "深圳灣", "深圳湾", "港珠澳", "皇崗", "皇岗", "文錦渡", "文锦渡", "沙頭角", "沙头角", "落馬洲", "落马洲"];
const MODELS = ["埃爾法", "埃尔法", "阿爾法", "阿尔法", "賓利", "宾利", "奔馳", "奔驰", "寶馬", "宝马", "奧迪", "奥迪", "GLE", "特斯拉", "Tesla", "豐田", "丰田", "本田", "日產", "日产"];

/**
 * 标题上下文：车型 / 口岸 / 业务线。
 * 只作为起草参考，绝不用于判断某条评论「该不该回」。
 * 不输出标价：2026-11-01 起评论区一律不报价，避免模型顺手把标题价写进回复。
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
  return { business, ports, models };
}

/**
 * 校验整份计划。
 * 必填：items[].index / name / action
 * action=reply 时必填 text；kw 可省略（由 content 自动生成）
 */
const GUIDE = {
  頭像: /頭像|头像|簡介|简介/,
  主頁: /主頁|主页/,
};

/** 这条回复走的是哪条引导路径（没引导返回 null） */
function guidePath(text) {
  const t = String(text || "");
  const hits = Object.keys(GUIDE).filter((k) => GUIDE[k].test(t));
  if (!hits.length) return null;
  const ORDER = ["主頁", "頭像"];
  return ORDER.find((k) => hits.includes(k)) || hits[0];
}

/**
 * 批次级检查：防止「清一色同一句式」。
 * 单条合规 ≠ 整批安全：连续多条都用同一个私域词收尾、句句一个模子，
 * 平台侧看到的是「批量营销话术」，会被折叠/限流（2026-10-27 实测 私訊 密度 56%）。
 *
 * 2026-11-02 改：
 *  - 私信类（私訊/私信/PM/DM/置頂/📩💬）改为 checkText 硬禁，不再设配额。
 *  - 分母仍为「滚动 7 天」；带引导占比 >50% 拒绝、>40% 警告。
 *  - 连续同路径：2 条为上限（第 3 条即拒）。
 */
/** 意图档位：A/1=到店，B/2=基础确认，C/3=高意向（问价/明细/条件/流程） */
function normalizeTier(v) {
  const s = String(v == null ? "" : v).trim().toUpperCase();
  if (["1", "A", "到店", "到店睇車", "到店看车"].includes(s)) return 1;
  if (["2", "B", "基础确认", "基礎確認"].includes(s)) return 2;
  if (["3", "C", "高意向"].includes(s)) return 3;
  return null;
}

const WINDOW = 7 * 24 * 3600 * 1000;

function windowReplies(replies, history, now) {
  const from = now - WINDOW;
  const hist = (history || [])
    .filter((h) => h && h.text && (!h.at || !Number.isFinite(Date.parse(h.at)) || Date.parse(h.at) > from))
    .map((h) => ({ text: String(h.text), video: h.video || null }));
  return hist.concat(replies);
}

function checkBatch(items, opt = {}) {
  const errors = [];
  const warnings = [];
  const replies = items
    .filter((x) => x.action === "reply" && x.text)
    .map((x) => ({ ...x, video: x.video || opt.video || null }));
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

  // 1.1 同一视频指路 ≤50%（2026-11-01：按视频聚合，不按单份计划）
  //     2026-11-01 实测：莲塘那条视频 14 条回复里 12 条带指路，拆成 4 份 plan 就绕过了单批闸门。
  //     「找明哥安排」这类提及但没有动作的不算指路
  const videoKey = (s) => String(s || "").replace(/\s+/g, "").slice(0, 20);
  const vid = opt.video ? videoKey(opt.video) : null;
  if (vid) {
    const same = all.filter((x) => x.video && videoKey(x.video) === vid);
    if (same.length >= 4) {
      const g = same.filter((x) => guidePath(x.text)).length;
      if (g / same.length > 0.5) {
        errors.push(
          `本视频近 7 天 ${g}/${same.length} 条带指路（${pct(g, same.length)}%），超过 50% —— 至少一半要直接答事实或纯回应；按视频聚合，拆 plan 也算在一起`
        );
      } else if (g / same.length > 0.4) {
        warnings.push(`本视频近 7 天指路 ${pct(g, same.length)}%（${g}/${same.length}），目标 ≤40%`);
      }
    }
  } else if (replies.length >= 4) {
    const g = replies.filter((x) => guidePath(x.text)).length;
    if (g / replies.length > 0.5) {
      errors.push(
        `本批 ${g}/${replies.length} 条带指路（${pct(g, replies.length)}%），超过 50% —— 至少一半要直接答事实或纯回应；提到「找明哥」但不带點頭像/主頁的不算指路`
      );
    } else if (g / replies.length > 0.4) {
      warnings.push(`本批指路 ${pct(g, replies.length)}%（${g}/${replies.length}），目标 ≤40%`);
    }
  }

  // 2. 私信类已由 checkText 硬禁（私訊/私信/PM/DM/置頂/📩💬），这里不再设配额

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

  // 4. 指路句式别形成新的清一色（2026-10-30）
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

      // 意图档位（2026-11-01）：A/1=到店，B/2=基础确认，C/3=高意向（问价/明细/条件/流程）
      // A/B 出现任何引导词 → 拒；C 才允许指路
      const tier = normalizeTier(x.tier);
      const paths = guidePaths(x.text);
      if (!tier) {
        errors.push(`${at}（${x.name}）缺少 tier：A/1=到店，B/2=基础确认，C/3=高意向（问价/明细/条件/流程）`);
      } else if (tier < 3 && paths.length) {
        errors.push(
          `${at}（${x.name}）tier ${tier <= 1 ? "A/1" : "B/2"} 不该带引导（${paths.join("/")}）：只有 C/3（问价/明细/条件/流程）才指路`
        );
      } else if (tier === 3 && !paths.length) {
        warnings.push(`${at}（${x.name}）tier C 但没带指路：确认是否漏了「點頭像／主頁」`);
      }

      if (!x.kw && !x.content) warnings.push(`${at}（${x.name}）没有 kw/content，靠昵称定位可能不唯一`);
    } else if (!x.reason) {
      warnings.push(`${at}（${x.name}）跳过但没写 reason`);
    }
  }

  const batch = checkBatch(plan.items, { history: opt.history, now: opt.now, video: opt.video });
  errors.push(...batch.errors);
  warnings.push(...batch.warnings);

  return { ok: errors.length === 0, errors, warnings };
}

/** 重复文案检查：最近 3 条内完全相同 → 阻断；7 天内用过 → 提醒 */
function checkDuplicates(plan, history) {
  // 比较时去掉表情与空白：模板整改会把表情从句尾移到句中，但句子还是同一句
  const key = (s) => String(s || "").replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF\uFE0F\s]/gu, "");
  const recent = (history || []).slice(-3).map((h) => key(h.text));
  const week = Date.now() - 7 * 24 * 3600 * 1000;
  const usedWeek = new Set(
    (history || []).filter((h) => Date.parse(h.at || 0) > week).map((h) => key(h.text))
  );

  const errors = [];
  const warnings = [];
  let prev = null;
  for (const x of plan.items) {
    if (x.action !== "reply") continue;
    if (recent.includes(key(x.text))) errors.push(`与最近发送的文案完全相同：${x.text}`);
    else if (usedWeek.has(key(x.text))) warnings.push(`7 天内用过同一句：${x.text}`);
    if (prev === key(x.text)) errors.push(`计划内相邻两条文案相同：${x.text}`);
    prev = key(x.text);
  }
  return { errors, warnings };
}

function load(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text);
}

module.exports = { BANNED, checkText, guidePaths, keywordOf, detectContext, validatePlan, checkDuplicates, load };
