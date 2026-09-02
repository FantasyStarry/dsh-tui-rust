/**
 * Chat view: transcript rows → (stream, live) frame lines.
 *
 * Pure function of (channel, editor, width, live UI state) — rebuilt per
 * render tick, never mutating inputs. All color goes through the theme
 * tokens; the frame never embeds raw SGR itself.
 *
 * Visual language (layered card school — pi / Claude Code / kimi-code):
 * a persistent chrome strip on top (brand · cwd · session) and a boxed
 * input + status-bar footer pinned at the bottom; user prompts render as
 * warm full-width bubbles, assistant voice carries a continuous teal left
 * bar with full-width code cards, tool runs as backgrounded cards with
 * status-colored headers, thinking as a spinning live row.
 *
 * Frame split (the scrollback-sealing contract, ADR-0001):
 * - `stream` — newly sealed transcript rows (final, immutable) plus the
 *   welcome card / route lines when due. Written once at the top of the
 *   tracked region; overflow scrolls into the terminal's native scrollback.
 * - `live` — persistent chrome + open rows of the current turn + input box
 *   + footer. Diffed in place every tick.
 */

import type { AgentRunState, Channel, SessionRoute, SessionUsage, TranscriptRow } from '../adapter/channel.js'
import { renderMarkdown } from './markdown.js'
import { renderPicker, type PickerState } from './picker.js'
import { boxed, type BoxStyle } from './box.js'
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
  /** Persistent chrome + open rows + input box + footer — diff-painted. */
  readonly live: readonly string[]
  /** Where the terminal cursor belongs (inside the input box). */
  readonly cursor: { readonly fromEnd: number; readonly col: number }
}

/** Hard cap for open-row lines in the live region (safety on tiny viewports). */
const MAX_OPEN_LINES = 120

/** Bottom-border hint, reused verbatim by the welcome card rules. */
const HINT = 'Enter 发送  ·  /model 模型  ·  Esc 取消  ·  Ctrl+C 退出'

/** Thinking spinner frames (single-cell quarter-circle pie). */
const SPIN = ['◐', '◓', '◑', '◒']

export function buildFrame(ctx: FrameContext): ChatFrame {
  const width = Math.max(20, ctx.width)
  const stream: string[] = []
  const live: string[] = []

  // Newly sealed transcript rows → written once into scrollback.
  const sealedTo = Math.min(ctx.channel.sealedRowCount, ctx.channel.rows.length)
  for (const row of ctx.channel.rows.slice(ctx.sealedFrom, sealedTo)) {
    stream.push(...renderRow(row, ctx), '')
  }

  // Live region: persistent chrome + open rows of the current turn.
  live.push(topBar(ctx, width))
  const openRows = ctx.channel.rows.slice(sealedTo)
  let openLines: string[] = []
  for (const row of openRows) {
    openLines.push(...renderRow(row, ctx), '')
  }
  if (openLines.length > MAX_OPEN_LINES) {
    const dropped = openLines.length - MAX_OPEN_LINES
    openLines = [theme.muted(`… 本回合前 ${dropped} 行暂省（回合结束后进历史）`), ...openLines.slice(-MAX_OPEN_LINES)]
  }
  if (openLines.length > 0) live.push('', ...openLines)

  const pickerLines = ctx.picker ? renderPicker(ctx.picker, width) : []
  if (pickerLines.length > 0) {
    live.push(...pickerLines)
    live.push('')
  }

  const inputLines = inputBox(ctx.editorText, width)
  const footer = footerLine(ctx.channel.runState, ctx.route, ctx.usage, width)
  const targetHeight = Math.max(8, ctx.height ?? 24)
  const spacer = Math.max(0, targetHeight - live.length - inputLines.length - 1)
  if (spacer > 0) live.push(...Array.from({ length: spacer }, () => ''))
  live.push(...inputLines)
  live.push(footer)
  // Cursor home: the input content row is 2 above the frame bottom
  // (hint border + footer below it); the `❯ ` prompt sits at col 3.
  const cursor = { fromEnd: 2, col: 5 + stringWidth(ctx.editorText) }
  return { stream, live, cursor }
}

/** One-time welcome block — a splash card; the transcript stays primary. */
export function welcomeCard(cwd: string, width: number): string[] {
  const style: BoxStyle = { bg: theme.chrome, border: theme.chromeBorder, title: '✦ orca', titlePaint: theme.primary }
  const content = [theme.muted('DeepSeek Harness 终端前端'), theme.subtle(short(cwd))]
  return [...boxed(content, width, style), '']
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
  switch (row.kind) {
    case 'user':
      return userBubble(row.text || '…', width)
    case 'assistant':
      return assistantBlock(row.text || '…', width)
    case 'thought':
      return thoughtLines(row, ctx, width)
    case 'tool':
      return toolCard(row, width)
    case 'system':
      return systemLines(row.text || '…', width)
  }
}

/** User prompt: warm full-width bubble, coral `❯`, first line bold. */
function userBubble(text: string, width: number): string[] {
  const inner = Math.max(8, width - 6)
  const wrapped = wrapWidth(text || '…', inner)
  const style: BoxStyle = { bg: theme.bubble, border: theme.bubbleBorder }
  const content = wrapped.map((line, index) =>
    index === 0 ? theme.primary('❯ ') + theme.strong(line) : theme.muted(line),
  )
  return boxed(content, width, style)
}

/** Assistant voice: continuous teal left bar + markdown (code as cards). */
function assistantBlock(text: string, width: number): string[] {
  const inner = Math.max(10, width - 2)
  const md = renderMarkdown(text || '…', inner)
  const bar = theme.accent('│ ')
  return md.map((line) => (line === '' ? '' : bar + line))
}

function thoughtLines(row: TranscriptRow, ctx: FrameContext, width: number): string[] {
  // Sealed: one collapsed summary line (full text stays in the session log).
  if (row.seconds !== undefined) {
    return [theme.live('  ✻ ') + theme.muted(`已思考 ${row.seconds}s`)]
  }
  // Streaming: spinning timer + the last two wrapped lines as a preview.
  const elapsed = row.startMs !== undefined ? Math.round((ctx.now - row.startMs) / 100) / 10 : 0
  const tick = row.startMs !== undefined ? Math.floor((ctx.now - row.startMs) / 120) % SPIN.length : 0
  const head = theme.live(`  ${SPIN[tick] ?? '◐'} 思考中 ${elapsed}s`)
  const wrapped = wrapWidth(row.text || '', Math.max(8, width - 6))
  const tail = wrapped.slice(-2).map((line) => theme.subtle('  ⋯ ' + line))
  return [head, ...tail]
}

/** Tool run: backgrounded card; status-colored marker + counts in the frame. */
function toolCard(row: TranscriptRow, width: number): string[] {
  const name = row.tool ?? 'tool'
  const mark =
    row.status === 'running'
      ? theme.primary('⏺')
      : row.status === 'ok'
        ? theme.ok('⏺')
        : row.status === 'failed'
          ? theme.fail('⏺')
          : theme.muted('⏺')
  const style: BoxStyle = { bg: theme.panel, border: theme.panelBorder }
  if (row.diff) {
    const title = mark + ' ' + theme.strong(`${name} ${row.diff.path}`)
    const right =
      `${row.diff.added > 0 ? theme.ok(`+${row.diff.added}`) : ''}` +
      `${row.diff.removed > 0 ? ' ' + theme.fail(`−${row.diff.removed}`) : ''}`
    const content: string[] = []
    for (const line of row.diff.lines) {
      const text = truncateCells(line.text, Math.max(8, width - 10))
      if (line.kind === 'add') content.push(theme.ok('+ ' + text))
      else if (line.kind === 'del') content.push(theme.fail('- ' + text))
      else content.push(theme.subtle('· ' + text))
    }
    return boxed(content, width, { ...style, title }, { right })
  }
  const suffix = row.status === 'running' ? theme.muted(' …') : ''
  const title = mark + ' ' + theme.strong(name) + suffix
  const wrapped = wrapWidth(row.text || '', Math.max(8, width - 8))
  const content = wrapped.slice(0, 3).map((line) => theme.subtle(line))
  return boxed(content, width, { ...style, title })
}

function systemLines(text: string, width: number): string[] {
  const wrapped = wrapWidth(text, Math.max(8, width - 4))
  return wrapped.map((line) => theme.accent('· ') + theme.muted(line))
}

/** Persistent top strip: brand · session · cwd on a chrome fill. */
function topBar(ctx: FrameContext, width: number): string {
  const brand = theme.strong('✦ orca')
  const session = ctx.sessionId ? theme.subtle(shortSession(ctx.sessionId)) : ''
  const cwd = theme.muted(short(ctx.cwd))
  return chromeLine([brand, session, cwd].filter((part) => part !== '').join(theme.subtle('  ·  ')), width)
}

/** Boxed input, Claude-Code-style: titled frame, `❯` prompt, hint in the rim. */
function inputBox(text: string, width: number): string[] {
  const w = Math.max(20, width)
  const style: BoxStyle = { bg: theme.chrome, border: theme.chromeBorder, title: '输入', titlePaint: theme.subtle }
  const prompt = theme.primary('❯')
  const body = text !== '' ? text : theme.placeholder('说点什么…')
  return boxed([`${prompt} ${body}`], w, style, { hint: theme.muted(HINT) })
}

/** Bottom status bar: run state · route · token usage on a chrome fill. */
function footerLine(state: AgentRunState, route: SessionRoute | null, usage: SessionUsage, width: number): string {
  const dot =
    state === 'idle' ? theme.ok('●') : state === 'thinking' ? theme.live('◐') : theme.primary('⏺')
  const label = state === 'idle' ? '就绪' : state === 'thinking' ? '思考中…' : '执行工具…'
  const parts: string[] = [theme.strong(`${dot} ${label}`)]
  if (route) {
    const effort = route.reasoningEffort ? `(${route.reasoningEffort})` : ''
    parts.push(theme.muted(`${route.provider}/${route.model}${effort}`))
  }
  if (usage.messages > 0) {
    const reasoning = usage.reasoning > 0 ? theme.live(` ✻${fmtTokens(usage.reasoning)}`) : ''
    parts.push(theme.muted(`↑${fmtTokens(usage.input)} ↓${fmtTokens(usage.output)}`) + reasoning)
  }
  return chromeLine(parts.join(theme.subtle('  │  ')), width)
}

/** Full-width chrome strip: padded content on a solid background fill. */
function chromeLine(content: string, width: number): string {
  const inner = Math.max(2, width - 4)
  let c = content
  if (stringWidth(c) > inner) c = truncateWidth(c, inner)
  const pad = Math.max(0, inner - stringWidth(c))
  return theme.chrome('  ' + c + ' '.repeat(pad) + '  ')
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

function shortSession(id: string): string {
  return id.length > 18 ? '…' + id.slice(-12) : id
}

function truncateCells(line: string, width: number): string {
  return truncateWidth(line, width)
}
