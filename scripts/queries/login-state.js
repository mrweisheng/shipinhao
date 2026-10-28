/**
 * queries/login-state.js
 *
 * 判断视频号登录状态 —— 纯 DOM 判断，不依赖截图。
 *
 * ★ 重要事实（实测）：
 *   二维码不在本页 DOM 里，而是在**跨域 iframe** 中：
 *     https://open.weixin.qq.com/connect/qrconnect?appid=...
 *   因此读不到二维码内容，也不需要读。iframe 存在且尺寸正常 = 二维码已渲染。
 *
 * ★ 另一个坑：
 *   页面上的「加载失败，点击重试」是 .mask 遮罩的残留文案，
 *   实测位于二维码**下方**（iframe y=385..593，mask y=593..801），不覆盖二维码，
 *   不是二维码加载失败。**不要**用它判断。
 *
 * 返回结构：
 *   loggedIn  是否已登录
 *   page      当前页面类型：login / platform / mobile / unknown
 *   hasQr     二维码 iframe 是否已渲染（尺寸 >= 150x150）
 *   hints     辅助信息（仅排查用，不参与判断）
 */
(() => {
  const url = location.href;
  const path = location.pathname;

  const qrFrame = [...document.querySelectorAll("iframe")].find((f) =>
    /qrconnect|open\.weixin\.qq\.com/.test(f.getAttribute("src") || "")
  );

  let qrSize = null;
  if (qrFrame) {
    const r = qrFrame.getBoundingClientRect();
    qrSize = [Math.round(r.width), Math.round(r.height)];
  }
  const hasQr = !!qrFrame && qrSize[0] >= 150 && qrSize[1] >= 150;

  const mask = document.querySelector(".qrcode-wrap .mask");
  const text = document.body ? document.body.innerText : "";

  const page = /\/login/i.test(path)
    ? "login"
    : /\/platform/i.test(path)
      ? "platform"
      : /\/mobile\//i.test(path)
        ? "mobile"
        : "unknown";

  return {
    loggedIn: page === "platform",
    page,
    url,
    title: document.title,
    hasQr,
    qrSize,
    qrFrameSrc: qrFrame ? (qrFrame.getAttribute("src") || "").slice(0, 70) : null,
    maskVisible: !!mask && getComputedStyle(mask).display !== "none",
    hints: {
      textHasRefreshTip: /加载失败|点击重试/.test(text), // 不可作为失败判据
      textHasExpired: /已过期|失效/.test(text),
      webdriver: navigator.webdriver,
    },
  };
})();
