#!/usr/bin/env bash
# dsh-tui companion 引导（macOS / Linux）
# 把 TUI 的伴生插件挂进 dsh 的 acp profile（幂等）。见 bootstrap.ps1 头注。
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
COMPANION="$REPO/companion/dsh-tui-companion"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PATCH_FILE="${DSH_HOME}/profiles/acp/cordis.patch.yml"

command -v dsh >/dev/null 2>&1 || { echo "未找到 dsh 命令——请先安装 DeepSeek Harness（npm i -g @deepseek-ai/dsh）"; exit 1; }
echo "==> dsh $(dsh --version 2>/dev/null || echo '?')"

# 1. companion 作为 profile 依赖
if dsh plugin --profile acp list 2>/dev/null | grep -q "dsh-tui-companion"; then
  echo "==> companion 已挂载 ✔"
else
  echo "==> dsh plugin --profile acp add（companion，link 到仓库）"
  dsh plugin --profile acp add "link:${COMPANION}"
fi

# 2. patch 插入行：workspace 服务 + tui-companion（缺失才追加）
need_ws=1; need_cp=1
[ -f "$PATCH_FILE" ] && grep -qE 'id: workspace\s*$' "$PATCH_FILE" && need_ws=0
[ -f "$PATCH_FILE" ] && grep -qE 'id: tui-companion\s*$' "$PATCH_FILE" && need_cp=0
if [ "$need_ws" = 1 ] || [ "$need_cp" = 1 ]; then
  cat >> "$PATCH_FILE" <<'ROWS'

# ── dsh-tui companion（bootstrap.sh 自动维护）──────────────────────────
# TUI 会话按 cwd 归入 web 工作区 + 空会话隔离（防模式选择器被残留空白顶掉）
- insert:
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'
- insert:
    - id: tui-companion
      name: dsh-tui-companion
ROWS
  echo "==> 已写入 patch 插入行 → $PATCH_FILE"
else
  echo "==> patch 插入行已就绪 ✔"
fi

echo ""
echo "companion 引导完成 ✔  TUI 启动后，会话将按 cwd 自动归入 web 工作区；"
echo "空残留会话自动隔离，web 新会话界面的模式选择器不再被顶掉。"
