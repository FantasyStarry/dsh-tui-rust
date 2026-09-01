# dsh-tui-rust 安装脚本（Windows）
#
# 作用：
#   1. cargo build --release 编译 dsh-tui / dtr 两个可执行文件
#   2. 把 dsh-tui.exe / dtr.exe（以及别名 dsh-tui-rust.exe）安装到
#      %USERPROFILE%\.dsh-tui\bin
#   3. 把该目录加入用户 PATH（新终端立即生效），之后直接输入 `dtr` 即可启动
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -SkipBuild      # 只复制已有产物
#   powershell -ExecutionPolicy Bypass -File install.ps1 -SkipCompanion  # 跳过 companion 引导

param(
    [switch]$SkipBuild,
    [switch]$SkipCompanion
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$binDir = Join-Path $HOME ".dsh-tui\bin"
$releaseDir = Join-Path $root "target\release"

if (-not $SkipBuild) {
    Write-Host "==> cargo build --release（dsh-tui + dtr）"
    Push-Location $root
    try {
        cargo build --release
        if ($LASTEXITCODE -ne 0) { throw "cargo build 失败（exit $LASTEXITCODE）" }
    } finally {
        Pop-Location
    }
} else {
    Write-Host "==> 跳过构建，直接复制产物"
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null

Copy-Item (Join-Path $releaseDir "dsh-tui.exe") $binDir -Force
Copy-Item (Join-Path $releaseDir "dtr.exe") $binDir -Force
# 兼容仓库名：dsh-tui-rust 也作为别名提供
Copy-Item (Join-Path $releaseDir "dsh-tui.exe") (Join-Path $binDir "dsh-tui-rust.exe") -Force

# 把 bin 目录加入用户 PATH（若不在其中）
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$binDir*") {
    $sep = if ([string]::IsNullOrEmpty($userPath)) { "" } else { ";" }
    [Environment]::SetEnvironmentVariable("Path", "$userPath$sep$binDir", "User")
    Write-Host "==> 已把 $binDir 加入用户 PATH（新开终端生效）"
} else {
    Write-Host "==> $binDir 已在用户 PATH 中"
}

Write-Host ""
Write-Host "安装完成 ✔"
Write-Host "  命令：dtr / dsh-tui / dsh-tui-rust（三者等价）"
Write-Host "  位置：$binDir"
Write-Host ""

# companion 引导（Phase 3）：把工作区归组插件挂进 dsh 的 acp profile
if (-not $SkipCompanion) {
    & (Join-Path $root "bootstrap.ps1")
} else {
    Write-Host "已跳过 companion 引导（-SkipCompanion）"
}
Write-Host "在项目目录打开新终端，直接输入 dtr 启动；TUI 内 /web 可启动 web 界面。"
