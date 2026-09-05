#!/usr/bin/env node
/**
 * Orca launcher: `orca` / `dsh-orca` ≡ `dsh --profile orca`.
 *
 * The TUI runs in-process inside the DeepSeek Harness kernel; this launcher
 * only forwards to the dsh CLI with the Orca profile. stdio stays fully
 * attached — the kernel's TUI service drives the terminal directly, so there
 * is no JSON-RPC plumbing, no child-process supervision, and no shim
 * gymnastics: the pain that defined the previous Rust ACP client design.
 *
 * `orca update` / `dsh-orca update` performs a self-update through npm
 * instead of launching the TUI.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'
import {
  currentOrcaVersion,
  fetchLatestOrcaVersion,
  installLatestOrca,
  compareVersions,
} from '../lib/update.js'

const profile = process.env['ORCA_PROFILE'] ?? 'orca'
const args = process.argv.slice(2)

async function runUpdate() {
  const current = currentOrcaVersion()
  console.log(`当前版本：v${current}`)
  const latest = await fetchLatestOrcaVersion()
  if (!latest) {
    console.error('检查最新版本失败：请确认网络或 npm 可用（npm view dsh-orca version）')
    process.exitCode = 1
    return
  }
  console.log(`最新版本：v${latest}`)
  if (compareVersions(latest, current) <= 0) {
    console.log('已是最新版本，无需更新')
    return
  }
  console.log('正在通过 npm 更新 dsh-orca ...')
  const result = await installLatestOrca()
  if (result.ok) {
    console.log(`更新成功：v${latest}`)
    console.log('请重启 Orca 使新版本生效（当前进程仍使用旧代码）')
  } else {
    console.error(`更新失败：${result.message}`)
    process.exitCode = 1
  }
}

if (args[0] === 'update' || args[0] === '--update') {
  await runUpdate()
} else {
  // Avoid Node's DEP0190 (shell:true + args array). On Windows npm's `dsh`
  // is a .cmd shim, so route through cmd.exe explicitly; elsewhere spawn dsh
  // directly.
  const child =
    process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', `dsh --profile "${profile.replaceAll('"', '""')}"`], {
          stdio: 'inherit',
          windowsHide: true,
          env: process.env,
        })
      : spawn('dsh', ['--profile', profile], {
          stdio: 'inherit',
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
}
