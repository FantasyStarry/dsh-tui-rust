/**
 * Chat view: transcript rows + single-line editor → frame lines.
 *
 * Pure function of (channel, editor, width, live UI state) — rebuilt per
 * render tick, never mutating inputs. All color goes through the theme
 * tokens; the frame never embeds raw SGR itself.
 */

import type { AgentRunState, Channel, SessionRoute, SessionUsage, TranscriptRow } from '../adapter/channel.js'
import { renderPicker, type PickerState } from './picker.js'
import { theme } from './theme.js'
import { wrapWidth } from './width.js'

export interface FrameContext {
  readonly channel: Channel
  readonly editorText: string
  readonly width: number
  readonly cwd: string
  readonly sessionId: string | null
  /** Live selection override (picker result) — wins over the logged route. */
  readonly route: SessionRoute | null
  readonly usage: SessionUsage
  /** Wall-clock now, for the live thought timer. */
  readonly now: number
  /** Active `/model` picker overlay lines, rendered above the status bar. */
  readonly picker: PickerState | null
}

const MAX_TRANSCRIPT_LINES = 512

export function buildFrame(ctx: FrameContext): string[] {
  const width = Math.max(20, ctx.width)
  const lines: string[] = []

  lines.push(truncateCells(headerLine(ctx), width))
  lines.push('')

  const transcript: string[] = []
  for (const row of ctx.channel.rows) {
    transcript.push(...renderRow(row, ctx))
  }
  for (const line of transcript.slice(-MAX_TRANSCRIPT_LINES)) {
    lines.push(line)
  }

  lines.push('')
  if (ctx.picker) {
    lines.push(...renderPicker(ctx.picker, width))
    lines.push('')
  }
  lines.push(statusLine(ctx.channel.runState, width))
  lines.push(inputLine(ctx.editorText, width))
  lines.push(theme.muted('Enter 发送 · /model 切换模型 · Esc 清空/取消 · Ctrl+C 退出'))
  return lines
}

function headerLine(ctx: FrameContext): string {
  const parts: string[] = [`── orca · ${short(ctx.cwd)}`]
  const route = ctx.route
  if (route) {
    const effort = route.reasoningEffort ? `(${route.reasoningEffort})` : ''
    parts.push(theme.warn(`${route.provider}/${route.model}${effort}`))
  } else {
    parts.push(theme.muted('route/默认'))
  }
  const usage = ctx.usage
  if (usage.messages > 0) {
    parts.push(theme.muted(`↑${fmtTokens(usage.input)} ↓${fmtTokens(usage.output)}${usage.reasoning > 0 ? ` ✻${fmtTokens(usage.reasoning)}` : ''}`))
  }
  if (ctx.sessionId) parts.push(theme.muted(`#${shortSession(ctx.sessionId)}`))
  return parts.join(' · ')
}

function renderRow(row: TranscriptRow, ctx: FrameContext): string[] {
  const width = Math.max(20, ctx.width)
  const wrapped = wrapWidth(row.text || '…', width - 2)
  switch (row.kind) {
    case 'user':
      return [theme.strong('❯ ' + (wrapped[0] ?? '')), ...wrapped.slice(1).map(theme.muted)]
    case 'assistant':
      return ['  ' + (wrapped[0] ?? ''), ...wrapped.slice(1).map((line) => '  ' + line)]
    case 'thought': {
      // Sealed: one collapsed summary line (full text stays in the session log).
      if (row.seconds !== undefined) {
        return [theme.muted(`  ✻ 已思考 ${row.seconds}s`)]
      }
      // Streaming: live timer + the last two wrapped lines as a preview.
      const elapsed = row.startMs !== undefined ? Math.round((ctx.now - row.startMs) / 100) / 10 : 0
      const head = theme.live(`  ✻ 思考中 ${elapsed}s`)
      const tail = wrapped.slice(-2).map((line) => theme.muted('  ⋯ ' + line))
      return [head, ...tail]
    }
    case 'tool': {
      const mark =
        row.status === 'ok'
          ? theme.ok('✔')
          : row.status === 'failed'
            ? theme.fail('✘')
            : theme.muted('◌')
      const head = `  [${mark}] ${row.tool ?? 'tool'}${row.status === 'running' ? theme.muted(' …') : ''}`
      return [truncateCells(head, width), ...wrapped.slice(0, 3).map((line) => theme.muted('      ' + line))]
    }
    case 'system':
      return wrapped.map((line) => theme.warn('  ⚑ ' + line))
  }
}

function statusLine(state: AgentRunState, width: number): string {
  const label = state === 'idle' ? '就绪' : state === 'thinking' ? '思考中…' : '执行工具…'
  const dot = state === 'idle' ? theme.ok('●') : theme.live('◐')
  return truncateCells(theme.strong(`${dot} ${label}`), width)
}

function inputLine(text: string, width: number): string {
  const prompt = theme.strong('❯ ')
  const body = text.length > 0 ? text : theme.muted('说点什么…')
  return truncateCells(prompt + body, width)
}

function fmtTokens(count: number): string {
  if (count >= 100000) return `${Math.round(count / 1000)}k`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return String(count)
}

function shortSession(id: string): string {
  return id.replace(/^session-/, '').slice(0, 8)
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
