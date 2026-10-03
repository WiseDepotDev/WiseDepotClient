<#
.SYNOPSIS
  手机 NFC（B3）真机走查：把 brief §8 里那三条验收跑成一次可复现的检查。

.DESCRIPTION
  验的三件事（全部来自 brief §8，缺一条就不算验过）：

    1. 进入应用能读到 —— logcat 出现 `readerMode=on`；
    2. 关掉系统 NFC 时走 DISABLED 分支（界面据此给「去开启」）；
    3. 切后台后 reader mode 真的关了 —— `readerMode=off`；
       外加 4. 贴一张卡能读到 —— `tagRead id=… tech=…`（要人真的贴卡）。

  **判定只认 ASCII 锚点**（`readerMode=on` / `readerMode=off` / `readerMode=skipped state=…` /
  `adapterChanged state=…` / `tagRead id=`）：这些锚点是壳里刻意打出来的
  （见 `NfcReader` / `MainActivity` 的日志行），所以这份脚本不会因为控制台编码、
  日志里的中文措辞变化而"看起来跑过了"。现场排障也可以直接
  `adb logcat -s WiseShell:I | findstr /C:"tagRead"`。

  退出码（**跳过不等于通过**，这是与 `desktop.ps1 -Smoke` 同源的一条纪律）：

    0 = 三条都真验到了
    2 = 有跳过项、没有失败（最常见：没插手机 / 这台机器没有 NFC / 没贴卡）
    1 = 有失败项

  所以"退出码 0"才代表这份记录能写进交付；退出码 2 只能写"未验"。

.PARAMETER Rebuild
  强制重建 Web 产物与 debug APK（默认只在缺产物时建 Web，APK 交给 Gradle 的增量判断）。

.PARAMETER TapSeconds
  等"贴卡"的秒数（默认 25）。没人贴卡时这一步记**跳过**，不是失败。

.EXAMPLE
  pnpm smoke:nfc-device
  pnpm smoke:nfc-device -Rebuild
#>
param(
    [switch]$Rebuild,
    [int]$TapSeconds = 25
)

$ErrorActionPreference = 'Stop'

# 仓库根 = 本脚本上一级（脚本放在 scripts/ 下）
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'package.json'))) {
    throw "看起来 $root 不是仓库根：找不到 package.json"
}
Set-Location $root

$script:passed = 0
$script:failed = 0
$script:skipped = 0

function Write-Section([string]$text) {
    Write-Host ''
    Write-Host "=== $text ===" -ForegroundColor Cyan
}
function Check-Pass([string]$name, [string]$detail = '') {
    $script:passed += 1
    Write-Host "  ✓ $name$(if ($detail) { " —— $detail" })" -ForegroundColor Green
}
function Check-Fail([string]$name, [string]$detail = '') {
    $script:failed += 1
    Write-Host "  ✗ $name$(if ($detail) { " —— $detail" })" -ForegroundColor Red
}
function Check-Skip([string]$name, [string]$reason) {
    $script:skipped += 1
    Write-Host "  - 跳过：$name —— $reason" -ForegroundColor Yellow
}

# ---------------------------------------------------------------- 1. adb

Write-Section '1/6 找 adb 与设备'

function Resolve-Adb {
    $onPath = Get-Command adb -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    # 退化到 Android SDK（local.properties 的 sdk.dir，与 Gradle 同一份配置）
    $props = Join-Path $root 'local.properties'
    if (Test-Path $props) {
        $line = (Get-Content $props | Where-Object { $_.Trim().StartsWith('sdk.dir=') } | Select-Object -First 1)
        if ($line) {
            $sdk = $line.Substring($line.IndexOf('=') + 1).Trim() -replace '\\\\', '\'
            $candidate = Join-Path $sdk 'platform-tools\adb.exe'
            if (Test-Path $candidate) { return $candidate }
        }
    }
    return $null
}

$adb = Resolve-Adb
if (-not $adb) {
    Check-Skip '整次走查' '本机没有 adb（装 Android SDK Platform-Tools 或把 adb 放进 PATH）'
    $adb = $null
} else {
    Write-Host "  · adb: $adb" -ForegroundColor DarkGray
}

$devices = @()
if ($adb) {
    $devices = @(& $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match '\tdevice$' } | ForEach-Object { ($_ -split '\t')[0] })
    if ($devices.Count -eq 0) {
        Check-Skip '整次走查' '没有已授权的设备（`adb devices` 空；插上手机并允许 USB 调试）'
    } else {
        Write-Host "  · 设备: $($devices -join ', ')" -ForegroundColor DarkGray
    }
}

if (-not $adb -or $devices.Count -eq 0) {
    Write-Section '结论'
    Write-Host "  通过 $($script:passed) / 跳过 $($script:skipped) / 失败 $($script:failed)" -ForegroundColor Yellow
    Write-Host '  跳过不等于通过：这一轮没有产生任何真机证据（brief §8 的三条仍然未验）。' -ForegroundColor Yellow
    exit 2
}

$target = $devices[0]

# ---------------------------------------------------------------- 2. 产物

Write-Section '2/6 产物（Web + debug APK）'

$webDist = Join-Path $root 'apps\web\dist\index.html'
if ($Rebuild -or -not (Test-Path $webDist)) {
    Write-Host '  · 构建 Web 产物（apps/web/dist）' -ForegroundColor DarkGray
    pnpm build | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "pnpm build 失败（退出码 $LASTEXITCODE）" }
} else {
    Write-Host '  · Web 产物已存在（-Rebuild 可强制重建）' -ForegroundColor DarkGray
}

# debug APK 一律交给 Gradle 的增量判断：它知道源码/资源有没有变，
# 手写"产物比源码新"在这种多输入（Kotlin + Manifest + Web 产物）的场景下必然漏。
$apkDir = Join-Path $root 'apps\mobile\shell\build\outputs\apk\debug'
Write-Host '  · 构建 debug APK（:apps:mobile:shell:assembleDebug）' -ForegroundColor DarkGray
& (Join-Path $root 'gradlew.bat') ':apps:mobile:shell:assembleDebug' --console=plain -q | Out-Host
if ($LASTEXITCODE -ne 0) { throw "assembleDebug 失败（退出码 $LASTEXITCODE）" }

$apk = Get-ChildItem $apkDir -Filter '*.apk' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $apk) { throw "找不到 debug APK：$apkDir" }
Write-Host "  · APK: $($apk.Name)（$([math]::Round($apk.Length / 1MB, 1)) MB）" -ForegroundColor DarkGray

# ---------------------------------------------------------------- 3. 安装与启动

Write-Section '3/6 安装并启动'

& $adb -s $target install -r -d $apk.FullName | Out-Host
if ($LASTEXITCODE -ne 0) { throw "adb install 失败（退出码 $LASTEXITCODE）" }

# 包名（applicationId）与 Activity 的**全名**不是一个东西：
# applicationId = com.huicang.wise.client，而 namespace = com.huicang.wise.client.shell，
# 所以组件名必须写全 —— 少写一段的表现是 `Activity class does not exist`（很容易被当成"壳没起来"）。
$component = 'com.huicang.wise.client/com.huicang.wise.client.shell.MainActivity'

function Get-NfcLog {
    # `-d` 只 dump 当前缓冲，不阻塞；`-s` 按 tag 过滤，避免把系统的 NFC 日志混进来
    return (& $adb -s $target logcat -d -s WiseShell:I 2>&1 | Out-String)
}

& $adb -s $target logcat -c | Out-Null
& $adb -s $target shell am force-stop com.huicang.wise.client | Out-Null
& $adb -s $target shell am start -n $component | Out-Host
Start-Sleep -Seconds 6

# ---------------------------------------------------------------- 4. 第一条：进入应用能读

Write-Section '4/6 进入应用：reader mode 起没起来'

$log = Get-NfcLog
if ($log -match 'readerMode=skipped state=UNSUPPORTED') {
    Check-Skip '进入应用能读到' '这台设备没有 NFC 硬件（壳不声明 nfc.read，界面也不画入口 —— 符合预期）'
} elseif ($log -match 'readerMode=on') {
    Check-Pass '进入应用能读到' 'reader mode 已在 onResume 起来'
} elseif ($log -match 'readerMode=skipped state=DISABLED') {
    Check-Fail '进入应用能读到' '系统里 NFC 是关的：先在手机上打开 NFC，再重跑本脚本（这一步同时也是第 5 条的反例）'
} else {
    Check-Fail '进入应用能读到' 'logcat 里既没有 readerMode=on 也没有 skipped —— 壳可能没起来，先看 adb logcat -s WiseShell:I'
}

# ---------------------------------------------------------------- 5. 第二条：关掉系统 NFC

Write-Section '5/6 关掉系统 NFC：走 DISABLED 分支'

Write-Host '  · 请在手机上把 NFC 关掉（下拉通知栏那枚开关即可），本脚本等 15 秒…' -ForegroundColor DarkGray
Start-Sleep -Seconds 15
$log = Get-NfcLog
if ($log -match 'adapterChanged state=DISABLED' -or $log -match 'readerMode=skipped state=DISABLED') {
    Check-Pass '关掉系统 NFC → DISABLED' '界面据此出现「NFC 未开启」+「去开启」'
} else {
    Check-Skip '关掉系统 NFC → DISABLED' 'logcat 里没有 DISABLED（可能没关、或这台设备没有 NFC）'
}

Write-Host '  · 请再把 NFC 打开（界面应当回到"请将标签靠近手机背部"）…' -ForegroundColor DarkGray
Start-Sleep -Seconds 8
$log = Get-NfcLog
if ($log -match 'adapterChanged state=READY') {
    Check-Pass '再打开 → 重新注册 reader mode' 'reader mode 被重新注册（不重开会表现为"贴卡没反应"）'
} else {
    Check-Skip '再打开 → 重新注册 reader mode' 'logcat 里没有 adapterChanged state=READY'
}

# ---------------------------------------------------------------- 6. 第三、四条：贴卡 + 切后台

Write-Section "6/6 贴卡（${TapSeconds}s 内）与切后台"

Write-Host "  · 把一张卡贴到手机背部（最多等 ${TapSeconds} 秒）…" -ForegroundColor DarkGray
$tagSeen = $false
$deadline = (Get-Date).AddSeconds($TapSeconds)
while ((Get-Date) -lt $deadline) {
    if ((Get-NfcLog) -match 'tagRead id=') { $tagSeen = $true; break }
    Start-Sleep -Seconds 2
}
if ($tagSeen) {
    Check-Pass '贴卡能读到' 'logcat 出现 `tagRead id=… tech=…`'
} else {
    Check-Skip '贴卡能读到' '这段窗口内没人贴卡（这一步只能人来触发，跳过不算验过）'
}

& $adb -s $target shell input keyevent 3 | Out-Null
Start-Sleep -Seconds 4
$log = Get-NfcLog
if ($log -match 'readerMode=off') {
    Check-Pass '切后台后 reader mode 已关' 'onPause 真的停了（否则会与别的 NFC 应用抢）'
} else {
    Check-Fail '切后台后 reader mode 已关' 'logcat 里没有 readerMode=off'
}

# ---------------------------------------------------------------- 结论

Write-Section '结论'
Write-Host "  通过 $($script:passed) / 跳过 $($script:skipped) / 失败 $($script:failed)"
if ($script:failed -gt 0) {
    Write-Host '  有失败项 —— 先修，再把 `NFC_READ_VERIFIED` 翻成 true。' -ForegroundColor Red
    exit 1
}
if ($script:skipped -gt 0 -or $script:passed -eq 0) {
    Write-Host '  有跳过项：**这不等于验过**，不能据此翻转 NFC_READ_VERIFIED。' -ForegroundColor Yellow
    exit 2
}
Write-Host '  三条（含贴卡）都真验到了 —— 记下机型 / 系统版本 / 卡型，再把 NFC_READ_VERIFIED 翻成 true。' -ForegroundColor Green
Write-Host '  （翻的时候同一次提交要更新 check-nfc.mjs 里那条"当前还没验"的断言，见 brief §8。）' -ForegroundColor DarkGray
exit 0
