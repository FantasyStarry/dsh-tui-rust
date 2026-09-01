# dsh-tui companion 引导（Windows）
#
# 把 TUI 的伴生插件挂进 dsh 的 acp profile，让 TUI 创建的会话自动归入
# web 端工作区（按 cwd 归组 + 空会话隔离）。幂等：重复执行只校验。
#
#   - profile 依赖：dsh plugin --profile acp add "link:<仓库>/companion/dsh-tui-companion"
#   - patch 插入行：workspace 服务（@deepseek-ai/dsh-workspace）+ tui-companion
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File bootstrap.ps1
#   powershell -ExecutionPolicy Bypass -File bootstrap.ps1 -PatchFile <path>  # 测试用
#
# 卸载：dsh plugin --profile acp rm dsh-tui-companion，并删除 cordis.patch.yml
# 里的 workspace / tui-companion 两段插入行。
param(
    [string]$PatchFile = ""
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$companion = Join-Path $repo "companion\dsh-tui-companion"
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
if (-not $PatchFile) { $PatchFile = Join-Path $dshHome "profiles\acp\cordis.patch.yml" }

# 0. dsh 存在性检查（companion 挂载进的是 dsh 的 profile）
if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
    throw "未找到 dsh 命令——请先安装 DeepSeek Harness（npm i -g @deepseek-ai/dsh）"
}
Write-Host "==> dsh $(& dsh --version 2>$null)"

# 1. companion 作为 profile 依赖（link 到仓库源码，随仓库同步）
$listed = (& dsh plugin --profile acp list 2>$null | Out-String)
if ($listed -match "dsh-tui-companion") {
    Write-Host "==> companion 已挂载 ✔"
} else {
    Write-Host "==> dsh plugin --profile acp add（companion，link 到仓库）"
    & dsh plugin --profile acp add "link:$companion"
    if ($LASTEXITCODE -ne 0) { throw "dsh plugin add 失败（exit $LASTEXITCODE）" }
}

# 2. patch 插入行：workspace 服务（归组依赖）+ tui-companion。
#    只在缺失时追加——不动用户已有的其它插件行。
$needWorkspace = -not (Test-Path $PatchFile) -or -not (Select-String -Path $PatchFile -Pattern "id: workspace\s*$" -Quiet)
$needCompanion = -not (Test-Path $PatchFile) -or -not (Select-String -Path $PatchFile -Pattern "id: tui-companion\s*$" -Quiet)
if ($needWorkspace -or $needCompanion) {
    $rows = @"

# ── dsh-tui companion（bootstrap.ps1 自动维护）──────────────────────────
# TUI 会话按 cwd 归入 web 工作区 + 空会话隔离（防模式选择器被残留空白顶掉）
- insert:
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'
- insert:
    - id: tui-companion
      name: dsh-tui-companion
"@
    Add-Content -Path $PatchFile -Value $rows -Encoding utf8
    Write-Host "==> 已写入 patch 插入行 → $PatchFile"
} else {
    Write-Host "==> patch 插入行已就绪 ✔"
}

Write-Host ""
Write-Host "companion 引导完成 ✔  TUI 启动后，会话将按 cwd 自动归入 web 工作区；"
Write-Host "空残留会话自动隔离，web 新会话界面的模式选择器不再被顶掉。"
