/**
 * queries/platform-nav.js
 *
 * 摸清视频号后台的 DOM 结构 —— 特别是 wujie 微前端 / shadow DOM 的情况。
 * 目的是确认：后续抓评论、点回复，能不能用常规选择器拿到元素。
 */
(() => {
  const shadowHosts = [];
  const all = document.querySelectorAll("*");
  for (const el of all) {
    if (el.shadowRoot) {
      shadowHosts.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: (el.className && String(el.className).slice(0, 60)) || null,
        textLen: (el.textContent || "").length,
      });
    }
  }

  // wujie 会把子应用挂进 shadowRoot，找找 wujie 的痕迹
  const wujieTags = Array.from(document.querySelectorAll("wujie-app, wujie-view, iframe"))
    .map((e) => ({ tag: e.tagName.toLowerCase(), src: e.getAttribute("src") || null, name: e.getAttribute("name") || null }));

  // 导航项：找短文本、看起来像菜单的元素
  const navCandidates = [];
  const seen = new Set();
  for (const el of document.querySelectorAll("a, li, div, span")) {
    const t = (el.textContent || "").trim();
    if (!t || t.length > 8 || seen.has(t)) continue;
    if (!/评论|互动|内容|数据|首页|发布|管理|消息|粉丝|创作|带货|直播/.test(t)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    seen.add(t);
    navCandidates.push({ text: t, tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 50) });
  }

  return {
    url: location.href,
    title: document.title,
    shadowHostCount: shadowHosts.length,
    shadowHosts: shadowHosts.slice(0, 10),
    wujieTags,
    navCandidates,
    bodyTextLen: (document.body.innerText || "").length,
    bodyTextHead: (document.body.innerText || "").slice(0, 300).replace(/\s+/g, " "),
  };
})();
