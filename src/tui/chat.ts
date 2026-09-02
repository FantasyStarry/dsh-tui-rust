/**
 * Chat view: transcript rows → (stream, live) frame lines.
 *
 * Pure function of (channel, editor, width, live UI state) — rebuilt per
 * render tick, never mutating inputs. All color goes through the theme
 * tokens; the frame never embeds raw SGR itself.
 *
 * Visual language (Claude Code / kimi-code school): a one-time welcome card
 * and slim route lines live in the scrollback stream — no persistent top
 * banner; ⏺ tool markers; a rounded input box pinned at the bottom with a
 * dim hint and a footer carrying state + route + usage.
 *
 * Frame split (the scrollback-sealing contract, ADR-0001):
 * - `stream` — newly sealed transcript rows (final, immutable) plus the
 *   welcome card / route lines when due. Written once at the top of the
 *   tracked region; overflow scrolls into the terminal's native scrollback.
 * - `live` — open rows of the current turn + input box + footer. Diffed
 *   in place every tick.
 */

import type { AgentRunState, Channel, SessionRoute, SessionUsage, TranscriptRow } from '../adapter/channel.js'
import { renderMarkdown } from './markdown.js'
import { renderPicker, type PickerState } from './picker.js'
import { theme } from './theme.js'
import { stringWidth, truncateWidth, wrapWidth } from './width.js'

export interface FrameContext {
  readonly channel: Channel
  /** First row index not yet flushed to scrollback (the app's cursor). */
  readonly sealedFrom: number
  readonly editorText: string
  readonly width: number
  /** Terminal rows; used to keep the prompt anchored at the bottom. */
  readonly height?: number
  readonly cwd: string
  readonly sessionId: string | null
  /** Live selection override (picker result) — wins over the logged route. */
  readonly route: SessionRoute | null
  readonly usage: SessionUsage
  /** Wall-clock now, for the live thought timer. */
  readonly now: number
  /** Active `/model` picker overlay lines, rendered above the input box. */
  readonly picker: PickerState | null
}

export interface ChatFrame {
  /** Newly sealed lines + one-time cards — written once, never repainted. */
  readonly stream: readonly string[]
  /** Open rows + input box + footer — diff-painted in place. */
  readonly live: readonly string[]
  /** Where the terminal cursor belongs (inside the input box). */
  readonly cursor: { readonly fromEnd: number; readonly col: number }
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

  // Live region: open rows of the current turn + the bottom chrome.
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
  const pickerLines = ctx.picker ? renderPicker(ctx.picker, width) : []
  if (pickerLines.length > 0) {
    live.push(...pickerLines)
    live.push('')
  }
  const targetHeight = Math.max(8, ctx.height ?? 24)
  const spacer = Math.max(0, targetHeight - live.length - 3)
  if (spacer > 0) live.push(...Array.from({ length: spacer }, () => ''))
  live.push(...inputBox(ctx.editorText, width))
  live.push(theme.muted('Enter 发送  ·  /model 模型  ·  Esc 取消  ·  Ctrl+C 退出'))
  live.push(footerLine(ctx.channel.runState, ctx.route, ctx.usage, width))
  // Cursor home: after the prompt text. Rows below it: hint + footer.
  const pickerExtra = pickerLines.length > 0 ? pickerLines.length + 1 : 0
  const cursor = { fromEnd: 2 + pickerExtra, col: 4 + stringWidth(ctx.editorText) }
  return { stream, live, cursor }
}

/** One-time welcome block — intentionally light so the transcript stays primary. */
export function welcomeCard(cwd: string, width: number): string[] {
  void width
  return [
    theme.strong('  orca') + theme.muted('  DeepSeek Harness 终端前端'),
    theme.muted('  ' + short(cwd)),
    '',
  ]
}

/** Slim in-stream line announcing the active route (on connect / change). */
export function routeLine(route: SessionRoute): string {
  const effort = route.reasoningEffort ? `(${route.reasoningEffort})` : ''
  return theme.accent(`↳ 模型 ${route.provider}/${route.model}${effort}`)
}

export function routeKey(route: SessionRoute): string {
  return `${route.provider}/${route.model}/${route.reasoningEffort ?? ''}`
}

function renderRow(row: TranscriptRow, ctx: FrameContext): string[] {
  const width = Math.max(20, ctx.width)
  const wrapped = wrapWidth(row.text || '…', width - 2)
  switch (row.kind) {
    case 'user':
      return [theme.strong('❯ ' + (wrapped[0] ?? '')), ...wrapped.slice(1).map(theme.muted)]
    case 'assistant':
      // Markdown for the model's voice; the md layer owns indentation.
      return renderMarkdown(row.text || '…', Math.max(12, width - 2)).map((line, index) =>
        index === 0 ? theme.accent('│ ') + line : '  ' + line,
      )
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
        row.status === 'running'
          ? theme.primary('⏺')
          : row.status === 'ok'
            ? theme.ok('⏺')
            : row.status === 'failed'
              ? theme.fail('⏺')
              : theme.muted('⏺')
      const diff = row.diff
      if (diff) {
        const head = truncateCells(`  ${mark} ${row.tool ?? 'tool'} ${diff.path}`, Math.max(12, width - 10))
        const removed = diff.removed > 0 ? ` ${theme.fail(`−${diff.removed}`)}` : ''
        out.push(theme.accent('  ┌ ') + head.slice(2) + ` ${theme.ok(`+${diff.added}`)}${removed}`)
        for (const line of diff.lines) {
          const text = truncateCells(line.text, Math.max(8, width - 8))
          if (line.kind === 'add') out.push(theme.ok(`  │ + ${text}`))
          else if (line.kind === 'del') out.push(theme.fail(`  │ - ${text}`))
          else out.push(theme.muted(`  │ · ${text}`))
        }
        out.push(theme.muted('  └'))
        return out
      }
      // Keep the tool label contiguous so it remains easy to scan and copy.
      out.push(truncateCells(`  ${mark} ${row.tool ?? 'tool'}${row.status === 'running' ? theme.muted(' …') : ''}`, width))
      out.push(...wrapped.slice(0, 3).map((line) => theme.muted('    └ ' + line)))
      return out
    }
    case 'system':
      return wrapped.map((line) => theme.accent('  · ') + theme.muted(line))
  }
}

/** Inline prompt, Claude-Code style, pinned at the bottom. */
function inputBox(text: string, width: number): string[] {
  const w = Math.max(20, width)
  const prompt = theme.primary('❯')
  const body = text !== '' ? text : theme.muted('说点什么…')
  return [truncateCells(` ${prompt} ${body}`, w)]
}

/** Bottom footer: run state + active route + cumulative usage. */
function footerLine(state: AgentRunState, route: SessionRoute | null, usage: SessionUsage, width: number): string {
  const dot = state === 'idle' ? theme.ok('●') : theme.live('◐')
  const label = state === 'idle' ? '就绪' : state === 'thinking' ? '思考中…' : '执行工具…'
  const parts = [theme.strong(`${dot} ${label}`)]
  if (route) {
    const effort = route.reasoningEffort ? `(${route.reasoningEffort})` : ''
    parts.push(theme.muted(`${route.provider}/${route.model}${effort}`))
  }
  if (usage.messages > 0) {
    parts.push(theme.muted(`↑${fmtTokens(usage.input)} ↓${fmtTokens(usage.output)}${usage.reasoning > 0 ? ` ✻${fmtTokens(usage.reasoning)}` : ''}`))
  }
  return truncateCells(parts.join(' · '), width)
}

function fmtTokens(count: number): string {
  if (count >= 100000) return `${Math.round(count / 1000)}k`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return String(count)
}

function short(cwd: string): string {
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
  const display = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
  return display.replaceAll('\\', '/')
}

function truncateCells(line: string, width: number): string {
  return truncateWidth(line, width)
}
