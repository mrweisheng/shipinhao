# capture-window.ps1
#
# 纯系统级窗口截图（Win32 PrintWindow），完全不接触浏览器内部。
# 用于「观察」而不「介入」—— 适合登录等敏感环节，不产生任何 CDP 痕迹。
#
# 用法：
#   .\scripts\capture-window.ps1 -Title "视频号助手"
#   .\scripts\capture-window.ps1 -ProcessId 8392 -Out ".\shots\a.png"

param(
    [string]$Title     = "视频号助手",
    [int]   $ProcessId = 0,
    [string]$Out       = ".\shots\window.png"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$sig = @"
using System;
using System.Runtime.InteropServices;
public class OCVWin32 {
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
if (-not ("OCVWin32" -as [type])) { Add-Type -TypeDefinition $sig }

if ($ProcessId -ne 0) {
    $proc = Get-Process -Id $ProcessId -ErrorAction Stop
} else {
    $proc = Get-Process chrome -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowTitle -like "*$Title*" } |
            Select-Object -First 1
}
if (-not $proc) { throw "未找到标题包含「$Title」的窗口。" }

$hwnd = $proc.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) { throw "进程 $($proc.Id) 没有主窗口句柄。" }

$rect = New-Object OCVWin32+RECT
$null = [OCVWin32]::GetWindowRect($hwnd, [ref]$rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { throw "窗口尺寸异常：${w}x${h}" }

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $gfx.GetHdc()
# flag 2 = PW_RENDERFULLCONTENT，能抓到被遮挡/未置顶的 Chrome 内容
$ok = [OCVWin32]::PrintWindow($hwnd, $hdc, 2)
$gfx.ReleaseHdc($hdc)
$gfx.Dispose()

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save((Join-Path (Get-Location) $Out), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

if ($ok) {
    Write-Host "[√] 已截图：$Out  (${w}x${h})" -ForegroundColor Green
} else {
    Write-Host "[!] PrintWindow 返回 false，图片可能是黑的" -ForegroundColor Yellow
}
