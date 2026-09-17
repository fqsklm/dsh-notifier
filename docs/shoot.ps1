# 生成 README 用的配图（只在本机跑，产物进 docs/images/，那个目录已 gitignore）
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File docs\shoot.ps1
#
# 三张图渲染的都是 docs/_mock/ 下的**还原页**：样式与结构逐字取自真实代码
# （extension/options.html 的面板样式、extension/background.js 里
# chrome.notifications.create 的真实字段），只把运行时才有的内容写成静态的。
# 直接开浏览器看这几个 html 也能看到同样的画面，不跑脚本也能自己截图。
#
# 为什么不去截真页面：options.html 要先注入假 chrome API 才有内容，而连接状态是
# options.js 每 3 秒自己刷出来的 —— 无头截图抓这一帧不稳（实测同一份文件既能截出
# 完整面板，也能截出一条 16px 高的空白）。还原页没有时序问题，代价是改 options.html
# 时要手动同步 docs/_mock/panel.html。
#
# 注意（踩过的坑）：
#   1. 本文件必须存成 **UTF-8 with BOM**。Windows PowerShell 5.1 没有 BOM 时按 ANSI(GBK)
#      解码 .ps1，中文注释会被拆坏、脚本报出完全不相干的错。
#   2. 读 UTF-8 的 html/js 必须用 .NET 的 ReadAllText，不能用 Get-Content -Raw
#      （同样原因，中文会变乱码，截出来是一张白图）。
#   3. Chrome 会往 stderr 写日志，而 $ErrorActionPreference='Stop' 会把原生命令的 stderr
#      当错误中断整个脚本，所以调用处一律收进 RunChrome。
#   4. 受限环境（沙箱）里 Chrome/Edge 起不来：headless 需要 mojo 的命名管道，
#      被拒后表现为 "platform_channel.cc Check failed: 拒绝访问"，不是脚本的问题。
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $PSScriptRoot 'images'
$tmp = Join-Path $PSScriptRoot '_mock\build'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'

if (-not (Test-Path $chrome)) { throw "找不到 Chrome: $chrome" }
New-Item -ItemType Directory -Force -Path $out, $tmp | Out-Null

# 跑一次 Chrome 并把它的输出收干净。
# PowerShell 5.1 下，原生命令往 stderr 写的每一行都会变成一个 NativeCommandError，
# 而 $ErrorActionPreference='Stop' 会让它直接终止脚本 —— 写了 2>&1 也一样
# （症状是"第一张图之后脚本就停了"，看起来像截图挂了）。所以这里临时放宽。
function RunChrome([string[]]$arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    return (& $chrome @arguments 2>&1 | Out-String)
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Shoot([string]$page, [string]$target, [int]$width, [int]$height, [string]$scale = '2') {
  Remove-Item -Force $target -ErrorAction SilentlyContinue
  $log = RunChrome @(
    '--headless=new', '--disable-gpu', '--hide-scrollbars', "--force-device-scale-factor=$scale",
    "--user-data-dir=$tmp\profile", '--no-first-run', '--no-default-browser-check',
    "--window-size=$width,$height", "--screenshot=$target", "file:///$($page -replace '\\', '/')"
  )
  if (-not (Test-Path $target)) {
    Write-Host $log
    throw "截图失败: $page"
  }
  # 截图空白时 Chrome 照样写文件（只是很小），所以这里顺手把尺寸打出来对一下。
  Add-Type -AssemblyName System.Drawing
  $image = [System.Drawing.Image]::FromFile($target)
  $size = "$($image.Width)x$($image.Height)"
  $image.Dispose()
  Write-Host "ok  $target  $size  $((Get-Item $target).Length) bytes"
}

Shoot (Join-Path $PSScriptRoot '_mock\panel.html') (Join-Path $out 'panel.png') 380 486 '2'
Shoot (Join-Path $PSScriptRoot '_mock\notification-approval.html') (Join-Path $out 'notification-approval.png') 420 190 '2'
Shoot (Join-Path $PSScriptRoot '_mock\notification-idle.html') (Join-Path $out 'notification-idle.png') 420 168 '2'
