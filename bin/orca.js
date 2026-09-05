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
 * Supported CLI:
 *   orca                    启动 Orca TUI
 *   orca update             通过 npm 自更新
 *   orca --help / -h        显示帮助
 *   orca --version / -v     显示版本号
 *   orca --profile <name>   使用指定 dsh profile（默认 orca）
 *   orca --fullscreen       以全屏备用屏模式启动
 *   orca --resume <id>      恢复指定会话
 *   orca --debug            开启 ORCA_DEBUG 诊断
 *   orca --nerd-font        开启 Nerd Font 分支图标
 */

import { spawn } from 'node:child_process'
import process from 'node:process'
import {
  currentOrcaVersion,
  fetchLatestOrcaVersion,
  installLatestOrca,
  compareVersions,
} from '../lib/update.js'

const args = process.argv.slice(2)
let profile = process.env['ORCA_PROFILE'] ?? 'orca'

function printHelp() {
  const version = currentOrcaVersion()
  console.log(`Orca v${version} — DeepSeek Harness 终端前端`)
  console.log('')
  console.log('用法：')
  console.log('  orca                         启动 Orca TUI')
  console.log('  orca update                  检查并更新 dsh-orca')
  console.log('  orca --help, -h              显示帮助')
  console.log('  orca --version, -v           显示版本号')
  console.log('')
  console.log('选项：')
  console.log('  --profile <name>             使用指定 dsh profile（默认 orca）')
  console.log('  --fullscreen                 以全屏备用屏模式启动（等价 ORCA_FULLSCREEN=1）')
  console.log('  --resume <sessionId>         恢复指定会话（等价 ORCA_RESUME_SESSION）')
  console.log('  --debug                      开启 ORCA_DEBUG 诊断')
  console.log('  --nerd-font                  开启页脚 Nerd Font 分支图标（等价 ORCA_NERD_FONT=1）')
}

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

// Simple flag parser for Orca-level options; unknown flags are ignored so
// `dsh` can still receive its own arguments if needed later.
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--profile' || arg === '-p') {
    profile = args[i + 1] ?? profile
    i++
  } else if (arg === '--fullscreen' || arg === '-f') {
    process.env['ORCA_FULLSCREEN'] = '1'
  } else if (arg === '--resume') {
    process.env['ORCA_RESUME_SESSION'] = args[i + 1] ?? ''
    i++
  } else if (arg === '--debug') {
    process.env['ORCA_DEBUG'] = '1'
  } else if (arg === '--nerd-font') {
    process.env['ORCA_NERD_FONT'] = '1'
  }
}

if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
  printHelp()
  process.exit(0)
}

if (args[0] === '--version' || args[0] === '-v' || args[0] === 'version') {
  console.log(currentOrcaVersion())
  process.exit(0)
}

if (args[0] === 'update' || args[0] === '--update') {
  await runUpdate()
  process.exit(process.exitCode ?? 0)
}

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
