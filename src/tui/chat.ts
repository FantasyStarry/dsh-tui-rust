/**
 * Chat view: transcript rows → (stream, live) frame lines.
 *
 * Pure function of (channel, editor, width, live UI state) — rebuilt per
 * render tick, never mutating inputs. All color goes through the theme
 * tokens; the frame never embeds raw SGR itself.
 *
 * Frame split (the scrollback-sealing contract, ADR-0001):
 * - `stream` — newly sealed transcript rows (final, immutable) plus the
 *   banner line whenever it changed. The renderer writes them once at the
 *   top of the tracked region; the overflow past the screen bottom scrolls
 *   into the terminal's native scrollback.
 * - `live` — open rows of the current turn + the chrome (status, editor,
 *   hints, picker overlay). Diff-painted in place every tick.
 */

import type { AgentRunState, Channel, SessionRoute, SessionUsage, TranscriptRow } from '../adapter/channel.js'
import { renderMarkdown } from './markdown.js'
import { renderPicker, type PickerState } from './picker.js'
import { theme } from './theme.js'
import { wrapWidth } from './width.js'

export interface FrameContext {
  readonly channel: Channel
  /** First row index not yet flushed to scrollback (the app's cursor). */
  readonly sealedFrom: number
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

export interface ChatFrame {
  /** Newly sealed lines + the banner on change — written once, never repainted. */
  readonly stream: readonly string[]
  /** Open rows + chrome — diff-painted in place. */
  readonly live: readonly string[]
}

/** Hard cap for open-row lines in the live region (safety on tiny viewports). */
const MAX_OPEN_LINES = 120

export function buildFrame(ctx: FrameContext): ChatFrame {
  const width = Math.max(20, ctx.width)
  const stream: string[] = []
  const live: string[] = []

  // Newly sealed transcript rows → written once into scrollback.
  const sealedTo = Math.min(ctx.channel.sealedRowCount, ctx.channel.rows.length)
  for (const row of ctx.channel.rows.slice(ctx.sealedFrom, sealedTo)) {
    stream.push(...renderRow(row, ctx))
  }

  // Live region: open rows of the current turn + the chrome.
  const openRows = ctx.channel.rows.slice(sealedTo)
  let openLines: string[] = []
  for (const row of openRows) {
    openLines.push(...renderRow(row, ctx))
  }
  if (openLines.length > MAX_OPEN_LINES) {
    const dropped = openLines.length - MAX_OPEN_LINES
    openLines = [theme.muted(`… 本回合前 ${dropped} 行暂省（回合结束后进历史）`), ...openLines.slice(-MAX_OPEN_LINES)]
  }

  if (openLines.length > 0) live.push('', ...openLines)
  live.push('')
  if (ctx.picker) {
    live.push(...renderPicker(ctx.picker, width))
    live.push('')
  }
  live.push(statusLine(ctx.channel.runState, width))
  live.push(inputLine(ctx.editorText, width))
  live.push(theme.muted('Enter 发送 · /model 切换模型 · Esc 清空/取消 · Ctrl+C 退出'))
  return { stream, live }
}

/** The session banner — pushed into the stream whenever it changes. */
export function bannerLine(cwd: string, route: SessionRoute | null, usage: SessionUsage, sessionId: string | null): string {
  const parts: string[] = [`── orca · ${short(cwd)}`]
  if (route) {
    const effort = route.reasoningEffort ? `(${route.reasoningEffort})` : ''
    parts.push(theme.warn(`${route.provider}/${route.model}${effort}`))
  } else {
    parts.push(theme.muted('route/默认'))
  }
  if (usage.messages > 0) {
    parts.push(theme.muted(`↑${fmtTokens(usage.input)} ↓${fmtTokens(usage.output)}${usage.reasoning > 0 ? ` ✻${fmtTokens(usage.reasoning)}` : ''}`))
  }
  if (sessionId) parts.push(theme.muted(`#${shortSession(sessionId)}`))
  return parts.join(' · ')
}

function renderRow(row: TranscriptRow, ctx: FrameContext): string[] {
  const width = Math.max(20, ctx.width)
  const wrapped = wrapWidth(row.text || '…', width - 2)
  switch (row.kind) {
    case 'user':
      return [theme.strong('❯ ' + (wrapped[0] ?? '')), ...wrapped.slice(1).map(theme.muted)]
    case 'assistant':
      // Markdown for the model's voice; the md layer owns base indentation.
      return renderMarkdown(row.text || '…', width)
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
      const out: string[] = []
      const mark =
        row.status === 'ok'
          ? theme.ok('✔')
          : row.status === 'failed'
            ? theme.fail('✘')
            : theme.muted('◌')
      const diff = row.diff
      if (diff) {
        // Diff card: header with path and +/- counts, then colored hunks.
        const head = truncateCells(`  ┌─ ${mark} ${row.tool ?? 'tool'} · ${diff.path}`, Math.max(12, width - 10))
        const removed = diff.removed > 0 ? ` ${theme.fail(`−${diff.removed}`)}` : ''
        out.push(theme.strong(head) + ` ${theme.ok(`+${diff.added}`)}${removed}`)
        for (const line of diff.lines) {
          const text = truncateCells(line.text, Math.max(8, width - 8))
          if (line.kind === 'add') out.push(theme.ok(`  │ + ${text}`))
          else if (line.kind === 'del') out.push(theme.fail(`  │ - ${text}`))
          else out.push(theme.muted(`  │   ${text}`))
        }
        out.push(theme.muted('  └─'))
        return out
      }
      const head = `  [${mark}] ${row.tool ?? 'tool'}${row.status === 'running' ? theme.muted(' …') : ''}`
      out.push(truncateCells(head, width))
      out.push(...wrapped.slice(0, 3).map((line) => theme.muted('      ' + line)))
      return out
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
