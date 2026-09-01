# dsh-tui-rust 卸载脚本（Windows）
#
# 作用：
#   1. 删除 %USERPROFILE%\.dsh-tui\bin 下的可执行文件（dsh-tui.exe / dtr.exe / dsh-tui-rust.exe）
#   2. 从用户 PATH 移除该目录
#   3. 保留 ~/.dsh-tui 下的用户数据（prefs.json / history.json / session-titles.json /
#      以及可选的 prices.json / permission.json / theme.json）——开发模式同样使用这些数据
#
# 用法：powershell -ExecutionPolicy Bypass -File uninstall.ps1

$ErrorActionPreference = "Stop"

$binDir = Join-Path $HOME ".dsh-tui\bin"

if (Test-Path $binDir) {
    Remove-Item $binDir -Recurse -Force
    Write-Host "==> 已删除 $binDir"
} else {
    Write-Host "==> $binDir 不存在（可能已卸载）"
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -and $userPath -like "*$binDir*") {
    $entries = $userPath -split ";" | Where-Object { $_ -and $_.TrimEnd('\') -ne $binDir.TrimEnd('\') }
    [Environment]::SetEnvironmentVariable("Path", ($entries -join ";"), "User")
    Write-Host "==> 已从用户 PATH 移除该目录（新开终端生效）"
} else {
    Write-Host "==> 用户 PATH 中没有该目录"
}

Write-Host ""
Write-Host "卸载完成 ✔（用户数据保留在 ~/.dsh-tui）"
Write-Host "开发模式：在项目目录运行 cargo run --release --bin dsh-tui"
