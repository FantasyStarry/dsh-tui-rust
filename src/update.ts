/**
 * Self-update helpers for dsh-orca.
 *
 * Both the `orca update` / `dsh-orca update` CLI path and the in-TUI
 * `/update` command share this module. Updates are performed through the
 * user's `npm`, so proxy/auth configuration is respected automatically.
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { readonly name: string; readonly version: string }

/** Current installed version from this package's own package.json. */
export function currentOrcaVersion(): string {
  return pkg.version
}

interface NpmResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

function runNpm(args: readonly string[], timeoutMs: number): Promise<NpmResult> {
  return new Promise((resolve) => {
    const child = spawn('npm', [...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** Latest published version on npm, or null when the check fails. */
export async function fetchLatestOrcaVersion(): Promise<string | null> {
  const result = await runNpm(['view', pkg.name, 'version'], 15_000)
  if (result.code !== 0) return null
  const version = result.stdout.trim().split('\n')[0]?.trim() ?? ''
  return /^\d+\.\d+\.\d+/.test(version) ? version : null
}

/** Simple semver-ish compare; returns <0 when a<b, 0 when equal, >0 when a>b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

/** Install the latest published version globally through npm. */
export async function installLatestOrca(): Promise<{ readonly ok: boolean; readonly message: string }> {
  const result = await runNpm(['install', '-g', `${pkg.name}@latest`], 120_000)
  if (result.code === 0) {
    return { ok: true, message: result.stdout.trim() || '更新完成' }
  }
  return { ok: false, message: result.stderr.trim() || `npm 退出码 ${result.code}` }
}
