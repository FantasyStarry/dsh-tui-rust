#!/bin/sh
# dsh-tui-rust 卸载脚本（macOS / Linux）
#
# 作用：
#   1. 删除 ~/.dsh-tui/bin 下的可执行文件（dsh-tui / dtr / dsh-tui-rust）
#   2. 从 shell 配置文件移除 PATH 行（.bashrc / .zshrc）
#   3. 保留 ~/.dsh-tui 下的用户数据（开发模式同样使用）
#
# 用法：sh uninstall.sh

set -e

BIN_DIR="$HOME/.dsh-tui/bin"

if [ -d "$BIN_DIR" ]; then
    rm -rf "$BIN_DIR"
    echo "==> 已删除 $BIN_DIR"
else
    echo "==> $BIN_DIR 不存在（可能已卸载）"
fi

for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [ -f "$rc" ] && grep -q ".dsh-tui/bin" "$rc"; then
        grep -v ".dsh-tui/bin" "$rc" > "$rc.tmp" && mv "$rc.tmp" "$rc"
        echo "==> 已从 $rc 移除 PATH 行"
    fi
done

echo ""
echo "卸载完成 ✔（用户数据保留在 ~/.dsh-tui）"
echo "开发模式：在项目目录运行 cargo run --release --bin dsh-tui"
