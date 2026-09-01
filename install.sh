#!/usr/bin/env bash
# dsh-tui-rust 安装脚本（macOS / Linux）
# 环境变量：SKIP_COMPANION=1 跳过末尾的 companion 引导
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${HOME}/.dsh-tui/bin"

echo "==> cargo build --release（dsh-tui + dtr）"
(cd "$ROOT" && cargo build --release)

mkdir -p "$BIN_DIR"
install -m 755 "$ROOT/target/release/dsh-tui" "$BIN_DIR/dsh-tui"
install -m 755 "$ROOT/target/release/dtr" "$BIN_DIR/dtr"
install -m 755 "$ROOT/target/release/dsh-tui" "$BIN_DIR/dsh-tui-rust"

case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) echo "==> 把 ${BIN_DIR} 加入 PATH（追加到 ~/.bashrc / ~/.zshrc）"
     echo "export PATH=\"${BIN_DIR}:\$PATH\"" >> "${HOME}/.bashrc" 2>/dev/null || true
     echo "export PATH=\"${BIN_DIR}:\$PATH\"" >> "${HOME}/.zshrc" 2>/dev/null || true ;;
esac

echo "安装完成 ✔  命令：dtr / dsh-tui / dsh-tui-rust"

# companion 引导（Phase 3）
if [ "${SKIP_COMPANION:-0}" != "1" ]; then
  bash "$ROOT/bootstrap.sh"
else
  echo "已跳过 companion 引导（SKIP_COMPANION=1）"
fi
