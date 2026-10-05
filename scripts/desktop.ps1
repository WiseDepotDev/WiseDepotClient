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

.PARAMETER NotifySmoke
  只跑**系统通知**那一片的自检：起一个假后端，把轮询压到 400ms，
  真的弹两个气泡到屏幕上（一个有声音、一个静默），然后把结论打印出来并退出。
  想确认"通知到底会不会弹"时用它 —— 它会真的占用你的屏幕十几秒。

.PARAMETER Rebuild
  强制重建全部产物（改了 Web / 桥 / 主进程之后用）。

.EXAMPLE
  .\scripts\desktop.ps1
  .\scripts\desktop.ps1 -Backend http://10.0.0.7:8080
  .\scripts\desktop.ps1 -Smoke
  .\scripts\desktop.ps1 -NotifySmoke
  .\scripts\desktop.ps1 -Rebuild
#>
[CmdletBinding()]
param(
    [string]$Backend = 'http://127.0.0.1:18080',
    [switch]$Smoke,
    [switch]$NotifySmoke,
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

<#
把主进程产物是否**过时**（源码比产物新）也算成"缺产物"。

为什么需要这一条：默认策略是"缺了才建"，于是**改了 `src/main.ts` 但产物还是旧的**时，
自检会拿旧代码跑 —— 它给出的绿或红都跟你刚写的代码无关。这不是假设：
B1/S2c 第一次跑自检就踩着它（修完 origin 判据仍然报同一个错，因为跑的是旧 bundle），
白查了一轮"为什么修复没生效"。

只对主进程做这条检查：它的构建是秒级的（esbuild 单文件），
Web 与桥的产物重建代价大得多，仍旧交给 `-Rebuild`。
#>
$mainSrcDir = Join-Path $root 'apps\desktop\src'
$mainStale = -not (Test-Path $mainJs)
if (-not $mainStale) {
    $builtAt = (Get-Item $mainJs).LastWriteTimeUtc
    $newerSrc = Get-ChildItem $mainSrcDir -Filter '*.ts' -File | Where-Object { $_.LastWriteTimeUtc -gt $builtAt }
    if ($newerSrc) { $mainStale = $true }
}

if ($Rebuild -or $mainStale) {
    if ($mainStale -and -not $Rebuild) {
        Write-Host '  · Electron 主进程产物比源码旧 → 重建（改了 main.ts 却用旧产物跑自检会得出误导结论）' -ForegroundColor Yellow
    }
    Invoke-Step '构建 Electron 主进程（apps/desktop/dist/main.cjs）' {
        pnpm --filter '@wise/desktop' build | Out-Host
    }
} else {
    Write-Host '  · Electron 主进程已存在且不旧（-Rebuild 可强制重建）' -ForegroundColor DarkGray
}

# ---------------------------------------------------------------- 2. 启动

$env:WISE_BACKEND_URL = $Backend

Write-Section '启动'
Write-Host "  后端      : $Backend"
Write-Host "  模式      : $(if ($NotifySmoke) { '通知自检（会真的弹气泡，跑完即退出）' } elseif ($Smoke) { '自检（跑完即退出）' } else { '正常窗口' })"
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
if ($NotifySmoke) { $args += '--notify-smoke' }

Push-Location (Join-Path $root 'apps\desktop')
try {
    & $electron @args
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}

# ---------------------------------------------------------------- 3. 结论

Write-Section '结束'
if ($NotifySmoke) {
    if ($code -eq 0) {
        Write-Host '  通知自检通过（气泡是否真的出现在屏幕上，只能你自己确认）。' -ForegroundColor Green
    } else {
        Write-Host "  通知自检失败（退出码 $code）—— 往上翻看 ✗ 那一行。" -ForegroundColor Red
    }
} elseif ($Smoke) {
    if ($code -eq 0) {
        Write-Host '  自检通过。' -ForegroundColor Green
    } else {
        Write-Host "  自检失败（退出码 $code）—— 往上翻看 ✗ 那一行。" -ForegroundColor Red
    }
} else {
    Write-Host "  窗口已关闭（退出码 $code）。" -ForegroundColor DarkGray
}
exit $code
