/**
 * Shared binary resolution for the dsh-tui npm shims.
 *
 * 平台预编译二进制的解析顺序：
 *   1. `DSH_TUI_BIN` 环境变量（显式覆盖）
 *   2. 包内 `dist/<platform>-<arch>/`（npm 分发的平台预编译产物，
 *      由 scripts/build-release.* 暂存，随 `npm publish` 的 files 上传）
 *   3. `~/.dsh-tui/bin/`（install.ps1 / install.sh 的安装位置）
 *   4. PATH（where / which）
 *
 * 都没有 → 打印安装指引并退出 1。
 */
"use strict";

const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EXE_EXT = process.platform === "win32" ? ".exe" : "";

/** npm 平台键：process.platform-arch（与 dist/ 目录命名一致）。 */
function platformKey() {
  return `${process.platform}-${process.arch}`;
}

/** 按 `appName`（dsh-tui / dtr）解析可执行文件；找不到返回 null。 */
function resolveBinary(appName) {
  const exe = appName + EXE_EXT;
  const candidates = [];
  if (process.env.DSH_TUI_BIN) candidates.push(process.env.DSH_TUI_BIN);
  candidates.push(path.join(__dirname, "..", "dist", platformKey(), exe));
  // dtr 与 dsh-tui 是同一份代码的别名：dtr shim 允许回退到 dsh-tui。
  if (appName === "dtr") candidates.push(path.join(__dirname, "..", "dist", platformKey(), "dsh-tui" + EXE_EXT));
  candidates.push(path.join(os.homedir(), ".dsh-tui", "bin", exe));
  if (appName === "dtr") candidates.push(path.join(os.homedir(), ".dsh-tui", "bin", "dsh-tui" + EXE_EXT));

  const found = candidates.find((p) => p && existsSync(p));
  if (found) return found;

  const lookup = spawnSync(process.platform === "win32" ? "where" : "which", [exe], {
    encoding: "utf8",
  });
  if (lookup.status === 0) {
    const first = lookup.stdout.trim().split(/\r?\n/)[0];
    if (first) return first;
  }
  return null;
}

function run(appName) {
  const bin = resolveBinary(appName);
  if (!bin) {
    console.error(`未找到 ${appName} 可执行文件。安装方式任选其一：`);
    console.error("  1. 在 dsh-tui-rust 仓库运行 install.ps1 / install.sh（cargo 构建 + 安装）");
    console.error("  2. cargo install --git <本仓库地址>");
    console.error("  3. 设置 DSH_TUI_BIN 指向已有的 dsh-tui 二进制");
    process.exit(1);
  }
  const r = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
  if (r.error) {
    console.error(`启动 ${bin} 失败: ${r.error.message}`);
    process.exit(1);
  }
  process.exit(r.status ?? 0);
}

module.exports = { run, platformKey };
