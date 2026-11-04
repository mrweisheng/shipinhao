#!/usr/bin/env node
/**
 * lib/browser-control.js — 只操作「自动化浏览器」的启停工具
 *
 * 关键原则：
 *   自动化 Chrome 和用户日常 Chrome 是同一个 chrome.exe，只是启动参数不同。
 *   ❌ 绝不能用 taskkill /IM chrome.exe（会关掉用户所有窗口）
 *   ✅ 只按 9222 端口的 PID，或按命令行里的 --user-data-dir=<项目 profile> 定位
 *
 * 用法（一般由 01-launch-chrome.js --restart 调用）：
 *   const { stopAutomation } = require("./lib/browser-control");
 *   await stopAutomation({ port: 9222, profile: "D:\\视频号\\profile" });
 */

const { execSync, execFileSync } = require("child_process");
const http = require("http");

function httpJson(port, urlPath, timeout = 1200) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath, timeout }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function isPortOpen(port) {
  try {
    await httpJson(port, "/json/version", 1200);
    return true;
  } catch {
    return false;
  }
}

/** 监听指定端口的 PID（Windows: netstat；mac/linux: lsof） */
function portPid(port) {
  if (process.platform === "win32") {
    try {
      const out = execSync("netstat -ano -p tcp", { encoding: "utf8", windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes(`:${port}`)) continue;
        if (!/LISTENING/i.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts[parts.length - 1]);
        if (pid) return pid;
      }
    } catch {}
    return null;
  }
  try {
    const out = execSync(`lsof -ti tcp:${port}`, { encoding: "utf8" });
    const pid = Number(out.split(/\s+/)[0]);
    return pid || null;
  } catch {
    return null;
  }
}

/** 命令行里带项目 profile 的 chrome 进程（只看 chrome.exe，不碰别的程序） */
function pidsByProfile(profile) {
  if (process.platform !== "win32") return [];
  try {
    const needle = String(profile).replace(/'/g, "''");
    const script = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') } | Select-Object -ExpandProperty ProcessId`;
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", windowsHide: true }
    );
    return out
      .split(/\r?\n/)
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

function killTree(pid) {
  if (!pid) return false;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(pid, "SIGKILL");
    }
    return true;
  } catch {
    return false;
  }
}

/** 优先 Browser.close（会 flush cookie），失败再按 PID 杀 */
async function gracefulClose(port, waitMs = 6000) {
  let version;
  try {
    version = await httpJson(port, "/json/version", 1200);
  } catch {
    return false;
  }
  const wsUrl = version && version.webSocketDebuggerUrl;
  if (!wsUrl) return false;

  const cdp = require("./cdp");
  let conn = null;
  try {
    conn = await Promise.race([
      cdp.attach(wsUrl),
      new Promise((_, reject) => setTimeout(() => reject(new Error("attach timeout")), 3000)),
    ]);
    try {
      await conn.send("Browser.close", {}, { timeout: 2500 });
    } catch {}
    try {
      conn.close();
    } catch {}
  } catch {
    return false;
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (!(await isPortOpen(port))) return true;
  }
  return !(await isPortOpen(port));
}

/**
 * 关闭自动化实例，返回做过的动作（给日志看）。
 * 顺序：Browser.close → 端口 PID → profile PID
 */
async function stopAutomation({ port = 9222, profile = null, log = () => {} } = {}) {
  const actions = [];

  if (await isPortOpen(port)) {
    const ok = await gracefulClose(port);
    if (ok) {
      actions.push("Browser.close（优雅关闭，保留登录态）");
      log("  ✓ Browser.close 成功");
    } else {
      log("  ⚠ Browser.close 无响应，改按端口 PID 关闭");
      const pid = portPid(port);
      if (pid && killTree(pid)) {
        actions.push(`kill PID ${pid}（端口 ${port}）`);
        log(`  ✓ 已关闭端口 ${port} 的 PID ${pid}（进程树）`);
      }
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  if (profile) {
    const leftover = pidsByProfile(profile);
    for (const pid of leftover) {
      if (killTree(pid)) {
        actions.push(`kill PID ${pid}（profile）`);
        log(`  ✓ 已关闭占用 profile 的 PID ${pid}（进程树）`);
      }
    }
  }

  return actions;
}

module.exports = { stopAutomation, isPortOpen, portPid, pidsByProfile, killTree };
