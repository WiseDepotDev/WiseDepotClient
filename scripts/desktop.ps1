#Requires -Version 5.1
<#
.SYNOPSIS
  启动 Windows 桌面端（Electron 宿主 + 桥子进程），用于人工查看运行状态。

.DESCRIPTION
  这个脚本只做三件事：**补齐产物** → **起进程** → **把该看的东西打出来**。
  它不隐藏任何东西：桥是一个独立的 JVM 子进程，它的日志会原样出现在这里的控制台。

  默认会先检查三样产物，缺了就现建（幂等，重复运行不会重复构建）：
    1. apps/web/dist            Web 产物（壳要装它）
    2. bridge/host-desktop/build/install/wise-bridge   桥的可执行分发
    3. apps/desktop/dist/main.cjs                      Electron 主进程

  两种模式：
    · 默认        —— 正常开窗口，自己点着看
    · -Smoke      —— 无人值守自检：把断言放进渲染进程里跑，打印结果后退出（退出码即结论）

.PARAMETER Backend
  后端地址。缺省 http://127.0.0.1:18080（本机 docker 栈上的真后端）。
  业务机是 http://10.0.0.7:8080 —— 在那个网络上时传这个值即可。

.PARAMETER Smoke
  跑自检而不是开窗口。

.PARAMETER Rebuild
  强制重建全部产物（改了 Web / 桥 / 主进程之后用）。

.EXAMPLE
  .\scripts\desktop.ps1
  .\scripts\desktop.ps1 -Backend http://10.0.0.7:8080
  .\scripts\desktop.ps1 -Smoke
  .\scripts\desktop.ps1 -Rebuild
#>
[CmdletBinding()]
param(
    [string]$Backend = 'http://127.0.0.1:18080',
    [switch]$Smoke,
    [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'

# 仓库根 = 本脚本上一级（脚本放在 scripts/ 下）
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'package.json'))) {
    throw "看起来 $root 不是仓库根：找不到 package.json"
}
Set-Location $root

function Write-Section([string]$text) {
    Write-Host ''
    Write-Host "=== $text ===" -ForegroundColor Cyan
}

function Invoke-Step([string]$name, [scriptblock]$action) {
    Write-Host "  · $name" -ForegroundColor DarkGray
    & $action
    if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
        throw "$name 失败（退出码 $LASTEXITCODE）"
    }
}

# ---------------------------------------------------------------- 1. 产物

$webDist = Join-Path $root 'apps\web\dist\index.html'
$bridgeDist = Join-Path $root 'bridge\host-desktop\build\install\wise-bridge\lib'
$mainJs = Join-Path $root 'apps\desktop\dist\main.cjs'
$electron = Join-Path $root 'apps\desktop\node_modules\.bin\electron.cmd'

Write-Section '环境检查'

if (-not (Test-Path $electron)) {
    throw @"
还没有安装 Electron。先跑一次：
  pnpm install
（Electron 运行时约 100MB，只需要下一次。）
"@
}

if ($Rebuild -or -not (Test-Path $webDist)) {
    Invoke-Step '构建 Web 产物（apps/web/dist）' { pnpm build | Out-Host }
} else {
    Write-Host '  · Web 产物已存在（-Rebuild 可强制重建）' -ForegroundColor DarkGray
}

if ($Rebuild -or -not (Test-Path $bridgeDist)) {
    Invoke-Step '构建桥（:bridge:host-desktop:installDist）' {
        & (Join-Path $root 'gradlew.bat') ':bridge:host-desktop:installDist' '-Pwise.skipAndroid' --console=plain -q | Out-Host
    }
} else {
    Write-Host '  · 桥产物已存在（-Rebuild 可强制重建）' -ForegroundColor DarkGray
}

if ($Rebuild -or -not (Test-Path $mainJs)) {
    Invoke-Step '构建 Electron 主进程（apps/desktop/dist/main.cjs）' {
        pnpm --filter '@wise/desktop' build | Out-Host
    }
} else {
    Write-Host '  · Electron 主进程已存在（-Rebuild 可强制重建）' -ForegroundColor DarkGray
}

# ---------------------------------------------------------------- 2. 启动

$env:WISE_BACKEND_URL = $Backend

Write-Section '启动'
Write-Host "  后端      : $Backend"
Write-Host "  模式      : $(if ($Smoke) { '自检（跑完即退出）' } else { '正常窗口' })"
Write-Host ''
Write-Host '  接下来会在本控制台看到两类日志，它们的来源不同：' -ForegroundColor DarkGray
Write-Host '    [bridge] …    ← 独立的 JVM 桥子进程（stderr 被主进程转发过来）' -ForegroundColor DarkGray
Write-Host '    [renderer] …  ← 页面里的 console（只有自检模式会转发）' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  排障时按这个顺序看：' -ForegroundColor DarkGray
Write-Host '    1. [bridge] ready port=…           桥起来了，端口是临时的' -ForegroundColor DarkGray
Write-Host '    2. [bridge] 自检：本进程回连 …     成功=端口真的在监听（失败就不用往下看了）' -ForegroundColor DarkGray
Write-Host '    3. [bridge] 前端已连接：…           页面连上来了' -ForegroundColor DarkGray
Write-Host '    4. [bridge] 握手被拒 …             有这一行说明 token/Origin 对不上' -ForegroundColor DarkGray
Write-Host ''

$args = @('.')
if ($Smoke) { $args += '--smoke' }

Push-Location (Join-Path $root 'apps\desktop')
try {
    & $electron @args
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}

# ---------------------------------------------------------------- 3. 结论

Write-Section '结束'
if ($Smoke) {
    if ($code -eq 0) {
        Write-Host '  自检通过。' -ForegroundColor Green
    } else {
        Write-Host "  自检失败（退出码 $code）—— 往上翻看 ✗ 那一行。" -ForegroundColor Red
    }
} else {
    Write-Host "  窗口已关闭（退出码 $code）。" -ForegroundColor DarkGray
}
exit $code
