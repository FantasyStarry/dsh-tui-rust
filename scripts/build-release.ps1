# 构建发布产物（Windows）：cargo build --release + 暂存到 npm/dist/<平台键>/
# 平台键与 npm shim 的解析目录一致（win32-x64 / linux-x64 / darwin-arm64 …）。
# 用法：powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1 [-SkipBuild]
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not $SkipBuild) {
    Write-Host "==> cargo build --release"
    Push-Location $root
    try {
        cargo build --release
        if ($LASTEXITCODE -ne 0) { throw "cargo build 失败（exit $LASTEXITCODE）" }
    } finally {
        Pop-Location
    }
}

$rustcOut = (& rustc -Vv) -join "`n"
$triple = ([regex]::Match($rustcOut, "host:\s*(\S+)")).Groups[1].Value
if (-not $triple) { throw "无法从 rustc -Vv 解析 host triple" }

# rustc host triple → npm 平台键（与 shim 的 process.platform-arch 对齐）
$map = @{
    "x86_64-pc-windows-msvc"     = "win32-x64"
    "aarch64-pc-windows-msvc"    = "win32-arm64"
    "x86_64-unknown-linux-gnu"   = "linux-x64"
    "aarch64-unknown-linux-gnu"  = "linux-arm64"
    "x86_64-apple-darwin"        = "darwin-x64"
    "aarch64-apple-darwin"       = "darwin-arm64"
}
$key = if ($map.ContainsKey($triple)) { $map[$triple] } else { $triple }
$exeExt = if ($triple -like "*windows*") { ".exe" } else { "" }

$dest = Join-Path $root "npm\dist\$key"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $root "target\release\dsh-tui$exeExt") $dest -Force
Copy-Item (Join-Path $root "target\release\dtr$exeExt") $dest -Force
Write-Host "==> 产物已暂存 $dest（npm/package.json 的 files 含 dist/，publish 时随包上传）"
Write-Host "==> 发布：cd npm && npm publish"
