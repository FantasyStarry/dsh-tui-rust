#!/usr/bin/env bash
# dsh-tui-rust 安装脚本（macOS / Linux）
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
