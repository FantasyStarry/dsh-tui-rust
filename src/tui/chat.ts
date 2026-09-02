/**
 * Chat view: transcript rows + single-line editor → frame lines.
 *
 * The skeleton keeps the view deliberately plain (no colors yet — the theme
 * token system from the pi research lands with the first styling pass). What
 * matters here is the frame contract: pure function of (channel, editor,
 * terminal width), rebuilt per render tick, never mutating inputs.
 */

import type { AgentRunState, Channel, TranscriptRow } from '../adapter/channel.js'
import { wrapWidth } from './width.js'

export interface FrameContext {
  readonly channel: Channel
  readonly editorText: string
  readonly width: number
  readonly cwd: string
  readonly sessionId: string | null
}

const MAX_TRANSCRIPT_LINES = 512

export function buildFrame(ctx: FrameContext): string[] {
  const width = Math.max(20, ctx.width)
  const lines: string[] = []

  lines.push(soft(`── orca · ${short(ctx.cwd)} · ${ctx.sessionId ?? 'session/booting'}`))
  lines.push('')

  const transcript: string[] = []
  for (const row of ctx.channel.rows) {
    transcript.push(...renderRow(row, width))
  }
  for (const line of transcript.slice(-MAX_TRANSCRIPT_LINES)) {
    lines.push(line)
  }

  lines.push('')
  lines.push(statusLine(ctx.channel.runState, width))
  lines.push(inputLine(ctx.editorText, width))
  lines.push(dim('Enter 发送 · Esc 清空 · Ctrl+C 退出'))
  return lines
}

function renderRow(row: TranscriptRow, width: number): string[] {
  const wrapped = wrapWidth(row.text || '…', width - 2)
  switch (row.kind) {
    case 'user':
      return [bold('❯ ' + (wrapped[0] ?? '')), ...wrapped.slice(1).map(dim)]
    case 'assistant':
      return ['  ' + (wrapped[0] ?? ''), ...wrapped.slice(1).map((line) => '  ' + line)]
    case 'thought':
      return wrapped.map((line) => dim('  · ' + line))
    case 'tool': {
      const mark = row.status === 'ok' ? '✔' : row.status === 'failed' ? '✘' : '◌'
      const head = `  [${mark}] ${row.tool ?? 'tool'}${row.status === 'running' ? ' …' : ''}`
      return [head, ...wrapped.slice(0, 3).map((line) => dim('      ' + line))]
    }
    case 'system':
      return wrapped.map((line) => soft('  ⚑ ' + line))
  }
}

function statusLine(state: AgentRunState, width: number): string {
  const label = state === 'idle' ? '就绪' : state === 'thinking' ? '思考中…' : '执行工具…'
  const dot = state === 'idle' ? '●' : '◐'
  return truncateCells(bold(`${dot} ${label}`), width)
}

function inputLine(text: string, width: number): string {
  const prompt = bold('❯ ')
  const body = text.length > 0 ? text : dim('说点什么…')
  return truncateCells(prompt + body, width)
}

// ── minimal SGR helpers (theme token system replaces these) ─────────────────

function bold(text: string): string {
  return `\x1b[1m${text}\x1b[22m`
}
function dim(text: string): string {
  return `\x1b[2m${text}\x1b[22m`
}
function soft(text: string): string {
  return `\x1b[2m\x1b[36m${text}\x1b[39m\x1b[22m`
}

function short(cwd: string): string {
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
  const display = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
  return display.replaceAll('\\', '/')
}

function truncateCells(line: string, width: number): string {
  let used = 0
  let out = ''
  for (const ch of line) {
    // SGR escapes carry zero width; pass them through untouched.
    if (ch === '\x1b') {
      out += ch
      continue
    }
    const w = ch.codePointAt(0)! > 0x1100 && /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60]/u.test(ch) ? 2 : 1
    if (used + w > width) break
    out += ch
    used += w
  }
  return out
}
