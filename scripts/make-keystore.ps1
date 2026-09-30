# 生成 Android release 签名密钥库，并把凭据写进 gitignored 的 local.properties。
#
# 为什么要有这个脚本：签名凭据**必须**可复现地生成、且**不进仓库**。
# 手工敲 keytool 参数容易漏（-validity 默认只有 90 天，过期的签名密钥无法再更新应用 ——
# 那个后果是"用户必须卸载重装"，比换签名更糟）。
#
# 用法：
#   powershell -File scripts/make-keystore.ps1
#   powershell -File scripts/make-keystore.ps1 -Force     # 已存在时覆盖（会作废旧签名！）
#
# 生成后：local.properties 会多出四个键，`gradlew :apps:mobile:shell:assembleRelease` 即可签名。

#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$StoreFile = 'keystore/wise-release.jks',
    [string]$Alias = 'wise-release',
    [int]$ValidityDays = 10950,   # 30 年：签名密钥的寿命必须长过应用寿命
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$storePath = Join-Path $root $StoreFile
$localProps = Join-Path $root 'local.properties'

if ((Test-Path $storePath) -and -not $Force) {
    Write-Host "密钥库已存在：$storePath（要覆盖请加 -Force —— 注意覆盖后旧签名无法再升级）" -ForegroundColor Yellow
    exit 0
}

Write-Host '=== 生成 release 签名密钥库 ===' -ForegroundColor Cyan
Write-Host "  文件   : $storePath"
Write-Host "  别名   : $Alias"
Write-Host "  有效期 : $ValidityDays 天（约 $([math]::Round($ValidityDays / 365)) 年）"
Write-Host ''

# 随机口令：不写死在脚本里，也不在终端回显
function New-Password {
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    # 只保留 base64url 里安全的字符，避免口令里的特殊字符在 properties / shell 里被转义
    return ([Convert]::ToBase64String($bytes) -replace '[+/=]', 'A').Substring(0, 24)
}

$storePassword = New-Password
$keyPassword = $storePassword   # 同一个口令：少一个要记的东西，且都只存在本机

$dir = Split-Path -Parent $storePath
if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir | Out-Null
}

# -dname 固定成项目标识；不填会让 keytool 交互提问，脚本就没法无人值守。
#
# **必须临时关掉 `$ErrorActionPreference = 'Stop'`**：keytool 的正常提示也走 stderr，
# 而 PowerShell 会把原生命令的 stderr 当成 NativeCommandError 直接终止脚本 ——
# 表现是"脚本报错了，而密钥库压根没生成"（踩过一次，白折腾一轮）。
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$keytoolExit = 1
try {
    & keytool -genkeypair `
        -keystore $storePath `
        -alias $Alias `
        -keyalg RSA -keysize 4096 `
        -validity $ValidityDays `
        -storepass $storePassword `
        -keypass $keyPassword `
        -dname "CN=WiseDepot, OU=Client, O=HuiCang, C=CN" 2>&1 | Out-Host
    $keytoolExit = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previous
}

if ($keytoolExit -ne 0) {
    throw "keytool 失败（退出码 $keytoolExit）"
}
if (-not (Test-Path $storePath)) {
    throw "keytool 报成功但密钥库不存在：$storePath"
}

# 写进 local.properties（该文件已在 .gitignore 里）
$lines = @()
if (Test-Path $localProps) {
    $lines = Get-Content $localProps | Where-Object {
        $_ -notmatch '^\s*RELEASE_(STORE_FILE|STORE_PASSWORD|KEY_ALIAS|KEY_PASSWORD)\s*='
    }
}
$lines += "RELEASE_STORE_FILE=$StoreFile"
$lines += "RELEASE_STORE_PASSWORD=$storePassword"
$lines += "RELEASE_KEY_ALIAS=$Alias"
$lines += "RELEASE_KEY_PASSWORD=$keyPassword"
# UTF-8 不带 BOM：Gradle 读 properties 时 BOM 会变成键名的一部分
[System.IO.File]::WriteAllLines($localProps, $lines, (New-Object System.Text.UTF8Encoding $false))

Write-Host ''
Write-Host '完成。凭据已写入 local.properties（gitignored）。' -ForegroundColor Green
Write-Host '接着跑： gradlew :apps:mobile:shell:assembleRelease' -ForegroundColor Green
Write-Host ''
Write-Host '提醒：这个密钥库一旦用于正式发布就不能丢 ——' -ForegroundColor Yellow
Write-Host '      丢了之后无法再给同一个应用发升级包（用户只能卸载重装）。请另行备份。' -ForegroundColor Yellow
