#!/usr/bin/env bash
# 构建发布产物（macOS / Linux）：cargo build --release + 暂存到 npm/dist/<平台键>/
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "${1:-}" != "--skip-build" ]; then
  echo "==> cargo build --release"
  (cd "$ROOT" && cargo build --release)
fi

TRIPLE="$(rustc -Vv | grep '^host:' | awk '{print $2}')"
case "$TRIPLE" in
  x86_64-pc-windows-msvc)    KEY=win32-x64 ;;
  aarch64-pc-windows-msvc)   KEY=win32-arm64 ;;
  x86_64-unknown-linux-gnu)  KEY=linux-x64 ;;
  aarch64-unknown-linux-gnu) KEY=linux-arm64 ;;
  x86_64-apple-darwin)       KEY=darwin-x64 ;;
  aarch64-apple-darwin)      KEY=darwin-arm64 ;;
  *)                         KEY="$TRIPLE" ;;
esac

DEST="$ROOT/npm/dist/$KEY"
mkdir -p "$DEST"
install -m 755 "$ROOT/target/release/dsh-tui" "$DEST/dsh-tui"
install -m 755 "$ROOT/target/release/dtr" "$DEST/dtr"
echo "==> 产物已暂存 $DEST（npm/package.json 的 files 含 dist/，publish 时随包上传）"
echo "==> 发布：cd npm && npm publish"
