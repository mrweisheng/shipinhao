# 01-launch-clean-chrome.ps1
#
# 以「干净」方式启动系统 Chrome，供后续 CDP 挂载使用。
#
# 干净的定义（这是整个方案的地基）：
#   - 不带 --enable-automation      → 不会出现「Chrome 正受到自动测试软件的控制」
#   - 不带 --headless               → 有窗口，人能看见
#   - 独立 user-data-dir            → 不抢用户正在用的 Chrome；登录态可持久化
#   - 默认 --no-proxy-server        → 强制直连，避免出境 IP 触发风控
#   - 关闭后台节流                  → 窗口被遮挡时页面 JS 仍正常跑（登录轮询不会卡死）
#
# 用法：
#   .\scripts\01-launch-clean-chrome.ps1
#   .\scripts\01-launch-clean-chrome.ps1 -Url "https://channels.weixin.qq.com/platform/"
#   .\scripts\01-launch-clean-chrome.ps1 -UseProxy        # 需要走梯子时显式开启

[CmdletBinding()]
param(
    [string]$Url        = "https://channels.weixin.qq.com/login.html",
    [int]   $Port       = 9222,
    [string]$ProfileDir = "",
    [double]$DeviceScaleFactor = 0,
    [switch]$UseProxy
)

$ErrorActionPreference = "Stop"

# $PSScriptRoot 在 param 默认值里可能为空，这里兜底解析脚本目录
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $ProfileDir) { $ProfileDir = Join-Path (Split-Path -Parent $ScriptDir) "profile" }

$ChromePaths = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$Chrome = $ChromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Chrome) { throw "未找到 Chrome，请确认安装路径。" }

function Test-CdpAlive {
    param([int]$P)
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$P/json/version" -TimeoutSec 2 -UseBasicParsing
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

# 已有实例则复用，只新开一个标签页
if (Test-CdpAlive -P $Port) {
    Write-Host "[i] 端口 $Port 已有 Chrome 在监听，复用该实例。" -ForegroundColor Yellow
    try {
        $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/new?$([uri]::EscapeDataString($Url))" `
            -Method Put -TimeoutSec 5 -UseBasicParsing
        Write-Host "[√] 已在新标签页打开：$Url" -ForegroundColor Green
    } catch {
        Write-Host "[!] 新建标签页失败（可能已打开）。手动切到 Chrome 即可。" -ForegroundColor Yellow
    }
    return
}

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

$chromeArgs = @(
    "--remote-debugging-port=$Port",
    "--user-data-dir=$ProfileDir",
    "--no-first-run",
    "--no-default-browser-check",
    "--start-maximized",
    # 不写死窗口尺寸：--start-maximized 会按当前屏幕自适应，
    # 换设备/换分辨率都不需要改脚本。
    # 窗口被遮挡/最小化时不节流，保证登录轮询正常
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-features=CalculateNativeWinOcclusion"
)

if (-not $UseProxy) {
    $chromeArgs += "--no-proxy-server"
}

# 可选：仅当实际设备上登录页确实被裁切时才用。
# 不要预设值 —— 缩放因设备而定，写死会在别的屏幕上适得其反。
if ($DeviceScaleFactor -gt 0) {
    $chromeArgs += "--force-device-scale-factor=$DeviceScaleFactor"
}

$chromeArgs += $Url

Write-Host "启动 Chrome：" -ForegroundColor Cyan
Write-Host "  可执行文件 : $Chrome"
Write-Host "  profile    : $ProfileDir"
Write-Host "  调试端口   : $Port"
Write-Host "  网络       : $(if ($UseProxy) { '跟随系统代理（会走香港节点）' } else { '强制直连' })"
Write-Host "  目标       : $Url"
Write-Host ""

Start-Process -FilePath $Chrome -ArgumentList $chromeArgs

$ok = $false
for ($i = 0; $i -lt 40; $i++) {
    if (Test-CdpAlive -P $Port) { $ok = $true; break }
    Start-Sleep -Milliseconds 300
}

if (-not $ok) { throw "启动超时：端口 $Port 未响应。检查 Chrome 是否被安全软件拦截。" }

$ver = (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing).Content | ConvertFrom-Json
Write-Host "[√] Chrome 已就绪" -ForegroundColor Green
Write-Host "    Browser : $($ver.Browser)"
Write-Host "    WS      : $($ver.webSocketDebuggerUrl)"
Write-Host ""
Write-Host "下一步：.\scripts\02-watch-login.js      等待扫码并监测登录结果" -ForegroundColor Cyan
