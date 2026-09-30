# 打包 Windows 桌面端：jlink 精简运行时 + electron-builder NSIS 安装包。
#
# 为什么必须自带运行时：目标机器上**不一定有 JDK**（甚至不一定有 java）。
# 主进程已经按"打包态"去找 `resources/runtime/bin/java(.exe)`（见 apps/desktop/src/main.ts），
# 所以这里只要把运行时放到那个位置就行。
#
# 用法：
#   powershell -File scripts/package-desktop.ps1
#   powershell -File scripts/package-desktop.ps1 -SkipJlink    # 运行时已生成时跳过（jlink 较慢）

#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Backend = 'http://127.0.0.1:18080',
    [switch]$SkipJlink
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Write-Section([string]$t) {
    Write-Host ''
    Write-Host "=== $t ===" -ForegroundColor Cyan
}

# ---------------------------------------------------------------- 1. 产物

Write-Section '1/4 构建 Web 产物'
pnpm build
if ($LASTEXITCODE -ne 0) { throw 'pnpm build 失败' }

Write-Section '2/4 构建桥（installDist）'
& (Join-Path $root 'gradlew.bat') ':bridge:host-desktop:installDist' '-Pwise.skipAndroid' --console=plain -q
if ($LASTEXITCODE -ne 0) { throw 'gradlew installDist 失败' }

Write-Section '3/4 构建 Electron 主进程'
pnpm --filter '@wise/desktop' build
if ($LASTEXITCODE -ne 0) { throw '主进程构建失败' }

# ---------------------------------------------------------------- 2. jlink 运行时

$runtimeDir = Join-Path $root 'apps\desktop\build\runtime'
if ($SkipJlink -and (Test-Path $runtimeDir)) {
    Write-Host '  跳过 jlink（-SkipJlink）'
} else {
    Write-Section '4/4 生成 jlink 精简运行时'
    if (Test-Path $runtimeDir) {
        Remove-Item -Recurse -Force $runtimeDir
    }
    # 模块集按**实际用到**的来：
    #   java.base        —— 一切的基础
    #   java.logging     —— 桥的日志
    #   java.naming      —— Netty 的 DNS/解析路径会引用
    #   java.management  —— Netty 的平台探测（Android 上缺席，桌面有）
    #   java.xml         —— kotlinx.serialization 之外的部分 XML 依赖
    #   jdk.unsupported  —— sun.misc.Unsafe（Netty 大量使用）
    #   jdk.crypto.ec    —— TLS 的椭圆曲线套件（OkHttp 连 https 后端时需要）
    #   jdk.zipfs        —— jar/资源读取
    # 少了任何一项的失败形态都是**运行期** NoClassDefFoundError，所以这份清单宁可多不可少。
    $modules = 'java.base,java.logging,java.naming,java.management,java.xml,jdk.unsupported,jdk.crypto.ec,jdk.zipfs'
    & jlink --add-modules $modules --strip-debug --no-header-files --no-man-pages --compress=zip-6 --output $runtimeDir
    if ($LASTEXITCODE -ne 0) { throw 'jlink 失败' }
    Write-Host "  运行时：$runtimeDir"
}

# 自检：打出来的 java 必须真能跑（这是"安装包能在没装 JDK 的机器上跑"的**唯一**证据）
$javaExe = Join-Path $runtimeDir 'bin\java.exe'
if (-not (Test-Path $javaExe)) { throw "运行时里没有 java.exe：$javaExe" }
# `java -version` 把版本写到 **stderr**，而 `$ErrorActionPreference='Stop'` 会把原生命令的
# stderr 当成 NativeCommandError 直接终止脚本 —— 必须临时关掉
# （与 make-keystore.ps1 的 keytool 是同一个坑，那一次也白折腾了一轮）。
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$version = (& $javaExe -version 2>&1 | Select-Object -First 1)
$ErrorActionPreference = $previous
if (-not $version) { throw "打出来的运行时跑不起来：$javaExe" }
Write-Host "  自检：$version"

# ---------------------------------------------------------------- 3. 打安装包

Write-Section '打包（electron-builder）'
$env:WISE_BACKEND_URL = $Backend
pnpm --filter '@wise/desktop' exec electron-builder --win nsis --publish never
if ($LASTEXITCODE -ne 0) { throw 'electron-builder 失败' }

Write-Host ''
Write-Host '完成。产物在 apps/desktop/release/' -ForegroundColor Green
Get-ChildItem (Join-Path $root 'apps\desktop\release') -Filter '*.exe' -ErrorAction SilentlyContinue |
    Select-Object Name, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } } |
    Format-Table -AutoSize | Out-String | Write-Host
