#!/usr/bin/env node
/**
 * Orca launcher: `orca` ≡ `dsh --profile orca`.
 *
 * The TUI runs in-process inside the DeepSeek Harness kernel; this launcher
 * only forwards to the dsh CLI with the Orca profile. stdio stays fully
 * attached — the kernel's TUI service drives the terminal directly, so there
 * is no JSON-RPC plumbing, no child-process supervision, and no shim
 * gymnastics: the pain that defined the previous Rust ACP client design.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'

const profile = process.env['ORCA_PROFILE'] ?? 'orca'

const child = spawn('dsh', ['--profile', profile], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: process.env,
})

child.on('error', (error) => {
  const code = /** @type {NodeJS.ErrnoException} */ (error).code
  if (code === 'ENOENT') {
    process.stderr.write(
      'orca: 未找到 dsh CLI。\n' +
        '  1) 安装 DeepSeek Harness：npm install -g @deepseek-ai/dsh\n' +
        '  2) 安装 Orca 进 profile：dsh plugin --profile ' + profile + ' add dsh-orca\n' +
        '  3) 重新运行：orca\n',
    )
    process.exitCode = 1
    return
  }
  process.stderr.write(`orca: 启动失败：${error.message}\n`)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  if (signal !== null) process.exitCode = null
  else process.exitCode = code ?? 0
})

// Forward termination signals so Ctrl+C in a wrapper script tears down the
// kernel the same way a direct `dsh --profile orca` run would.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal)
  })
}
