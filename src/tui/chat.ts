/**
 * Chat view: transcript rows → (stream, live) frame lines.
 *
 * Pure function of (channel, editor, width, live UI state) — rebuilt per
 * render tick, never mutating inputs. All color goes through the theme
 * tokens; the frame never embeds raw SGR itself.
 *
 * Visual language — the kimi-code school (MoonshotAI/kimi-code:
 * `src/tui/components/messages`, `components/editor`, `components/chrome`,
 * `constant/symbols.ts`, `constant/rendering.ts`):
 * - user prompts: `✨` amber bold role bullet, no bubble;
 * - assistant voice: `● ` body-color bullet + markdown (code as cards);
 * - thinking: braille spinner + dim italic preview, sealed to `● 已思考 Ns`;
 * - tool runs: backgrounded cards, `⠋`/`✓ `/`✗ ` status marks in the frame;
 * - chrome: a boxed `> ` prompt editor (primary border), a two-line plain
 *   status footer (no fill), a boxed welcome card with info rows;
 * - a 1-cell chrome gutter lines transcript/panels up with the editor
 *   interior (kimi CHROME_GUTTER); the editor spans the full width.
 *
 * Frame split (the scrollback-sealing contract, ADR-0001):
 * - `stream` — newly sealed transcript rows (final, immutable) plus the
 *   welcome card / route lines when due. Written once at the top of the
 *   tracked region; overflow scrolls into the terminal's native scrollback.
 * - `live` — open rows of the current turn + editor box + footer. Diffed
 *   in place every tick.
 */

import type { AgentRunState, Channel, SessionRoute, SessionUsage, TranscriptRow } from '../adapter/channel.js'
import { renderMarkdown } from './markdown.js'
import { renderPicker, type PickerItem, type PickerState } from './picker.js'
import { boxed, boxLine, boxTop, boxBottom, type BoxStyle } from './box.js'
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
  /** Rows written above this live frame during the current render. */
  readonly reservedRows?: number
  readonly anchorChrome?: boolean
  readonly cwd: string
  readonly sessionId: string | null
  /** Live selection override (picker result) — wins over the logged route. */
  readonly route: SessionRoute | null
  readonly usage: SessionUsage
  /** Wall-clock now, for the live thought timer. */
  readonly now: number
  /** Active `/model` picker overlay lines, rendered above the input box. */
  readonly picker: PickerState | null
  /** Inline slash-command completion (kimi `/` menu), above the input box. */
  readonly commandMenu?: { readonly items: readonly PickerItem[]; readonly index: number } | null
  /** Ctrl+O toggle: show full thinking text instead of the short preview. */
  readonly thoughtExpanded?: boolean
  /** True while the agent is still connecting (footer shows 连接中 badge). */
  readonly connecting?: boolean
  /** Folded session title for the footer (M3). */
  readonly title?: string | null
  /** Effective approval policy for the footer (M4: ask/never). */
  readonly policy?: string
  /** Yolo auto-allow flag for the footer badge (M4). */
  readonly yolo?: boolean
  /** Git branch for the footer slot (M4 status slot, best-effort). */
  readonly branch?: string | null
}

export interface ChatFrame {
  /** Newly sealed lines + one-time cards — written once, never repainted. */
  readonly stream: readonly string[]
  /** Open rows + editor box + footer — diff-painted in place. */
  readonly live: readonly string[]
  /** Where the terminal cursor belongs (inside the editor box). */
  readonly cursor: { readonly fromEnd: number; readonly col: number }
}

const HINT = 'Enter 发送  ·  /model 模型  ·  Ctrl+O 思考  ·  Esc 取消  ·  Ctrl+C 退出'

/** kimi symbols.ts: role bullets, status marks; `✨` carries VS16 so both our
 *  cell math (1+1) and real emoji rendering (2 cells) agree on 3. */
const USER_BULLET = '✨\uFE0F '
const STATUS_BULLET = '● '
const SUCCESS_MARK = '✓ '
const FAILURE_MARK = '✗ '
const MESSAGE_INDENT = '  '

/** kimi rendering.ts BRAILLE_SPINNER_FRAMES (80ms per frame). */
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function buildFrame(ctx: FrameContext): ChatFrame {
  const width = Math.max(20, ctx.width)
  const height = Math.max(8, ctx.height ?? 24)
  const anchorChrome = ctx.anchorChrome ?? ctx.picker !== null
  const reservedRows = anchorChrome ? Math.max(0, Math.min(height - 1, ctx.reservedRows ?? 0)) : 0
  const stream: string[] = []
  const live: string[] = []
  // Content area: transcript + panels sit inside a 1-cell chrome gutter
  // (kimi CHROME_GUTTER) so their left edge aligns with the editor interior;
  // the editor box and welcome card span the full width.
  const inner = Math.max(18, width - 2)
  const gutter = (line: string): string => (line === '' ? '' : ' ' + line + ' ')

  // Newly sealed transcript rows → written once into scrollback.
  const sealedTo = Math.min(ctx.channel.sealedRowCount, ctx.channel.rows.length)
  for (const row of ctx.channel.rows.slice(ctx.sealedFrom, sealedTo)) {
    stream.push(...renderRow(row, ctx, inner).map(gutter))
  }

  // Live region: open rows of the current turn + optional picker + bottom
  // chrome. The chrome is bottom-anchored; spacer rows absorb free height.
  const openRows = ctx.channel.rows.slice(sealedTo)
  let openLines: string[] = []
  for (const row of openRows) {
    openLines.push(...renderRow(row, ctx, inner).map(gutter))
  }

  const bottom = [...inputBox(ctx.editorText, width), ...footerLines(ctx, width)]
  // A picker is part of the live frame (unlike sealed transcript stream), so
  // its visible rows must fit above the input/footer chrome. Without this
  // budget a long provider/model list makes the terminal scroll mid-frame;
  // the next route stream then repaints against the wrong physical row and
  // leaves a ghost input box at the top of the screen.
  const availableRows = anchorChrome ? Math.max(bottom.length + 2, height - reservedRows) : height
  const pickerItemBudget = Math.max(1, availableRows - bottom.length - 7)
  let pickerLines = ctx.picker ? renderPicker(ctx.picker, inner, pickerItemBudget).map(gutter) : []
  if (pickerLines.length > 0) {
    // Keep one row for the separator before the editor. On very short
    // terminals the picker may still have a "more" marker; trim that marker
    // (and any excess items) rather than allowing the terminal to scroll.
    const maxPickerLines = Math.max(1, availableRows - bottom.length - 1)
    pickerLines = pickerLines.slice(0, maxPickerLines)
  }
  // Inline slash-command menu (non-modal, never coexists with a picker).
  // Same height discipline: it must fit above the input/footer chrome.
  let menuLines: string[] = []
  if (!ctx.picker && ctx.commandMenu && ctx.commandMenu.items.length > 0) {
    const menuBudget = Math.max(1, Math.min(9, availableRows - bottom.length - 7))
    const menuState: PickerState = {
      title: '命令',
      items: ctx.commandMenu.items,
      index: Math.max(0, Math.min(ctx.commandMenu.items.length - 1, ctx.commandMenu.index)),
    }
    menuLines = renderPicker(menuState, inner, menuBudget).map(gutter)
    const maxMenuLines = Math.max(1, availableRows - bottom.length - pickerLines.length - 1)
    menuLines = menuLines.slice(0, maxMenuLines)
  }
  // The open-row window is capped so the frame never outgrows the terminal —
  // the diff painter can only repaint rows that are on screen. Overflow
  // collapses into a note and resumes into scrollback at the next seal.
  const pickerReserve = pickerLines.length > 0 ? pickerLines.length + 1 : 0
  const menuReserve = menuLines.length > 0 ? menuLines.length + 1 : 0
  const maxOpen = Math.max(0, availableRows - bottom.length - pickerReserve - menuReserve)
  if (openLines.length > maxOpen) {
    const dropped = openLines.length - maxOpen
    if (maxOpen > 0) {
      const tailCount = Math.max(0, maxOpen - 1)
      openLines = [theme.muted(`… 本回合前 ${dropped} 行暂省（回合结束后进历史）`), ...openLines.slice(-tailCount)]
    } else {
      openLines = []
    }
  }
  // The chrome is bottom-anchored: consume the remaining viewport with blank
  // rows between transcript/picker content and the input box/footer.
  const spacer = anchorChrome ? Math.max(0, maxOpen - openLines.length) : 0
  live.push(...openLines, ...Array.from({ length: spacer }, () => ''))

  if (pickerLines.length > 0) {
    live.push(...pickerLines)
    live.push('')
  }
  if (menuLines.length > 0) {
    live.push(...menuLines)
    live.push('')
  }
  live.push(...bottom)
  // Cursor home: the editor content row is 3 above the frame bottom (box
  // bottom + footer L1 + L2); `│ > ` puts the text at column 5.
  const cursor = { fromEnd: bottom.length - 2, col: 5 + stringWidth(ctx.editorText) }
  return { stream, live, cursor }
}

/** One-time welcome block — kimi-style box with info rows; brand wordmark. */
export function welcomeCard(cwd: string, sessionId: string | null, model: string | null, width: number): string[] {
  const style: BoxStyle = { bg: (t) => t, border: theme.primary }
  const logo = ['▝▀▀▀▜', '▐▄▄▄▌'] as const
  const logoW = 5
  const gap = '  '
  const row0 = theme.primary(logo[0].padEnd(logoW)) + gap + theme.title('✦ orca')
  const row1 = theme.primary(logo[1].padEnd(logoW)) + gap + theme.subtle('DeepSeek Harness 终端前端')
  const label = (text: string): string => theme.strong(theme.subtle(text))
  const info = [
    label('Directory:') + '  ' + short(cwd),
    label('Session:') + '    ' + (sessionId ? shortSession(sessionId) : '—'),
    label('Model:') + '      ' + (model ?? theme.warn('未设置')),
  ]
  return ['', ...boxed(['', row0, row1, '', ...info, ''], width, style), '']
}

/** Slim in-stream line announcing the active route (on connect / change). */
export function routeLine(route: SessionRoute): string {
  const effort = route.reasoningEffort ? `(${route.reasoningEffort})` : ''
  return theme.accent(`↳ 模型 ${route.provider}/${route.model}${effort}`)
}

export function routeKey(route: SessionRoute): string {
  return `${route.provider}/${route.model}/${route.reasoningEffort ?? ''}`
}

function renderRow(row: TranscriptRow, ctx: FrameContext, width: number): string[] {
  switch (row.kind) {
    case 'user':
      return userLines(row.text || '…', width)
    case 'assistant':
      return assistantLines(row.text || '…', width)
    case 'thought':
      return thoughtLines(row, ctx, width)
    case 'tool':
      return toolCard(row, width)
    case 'system':
      return ['', ...wrapWidth(row.text || '…', Math.max(8, width - 2)).map((line) => theme.muted(MESSAGE_INDENT + line))]
  }
}

/** User prompt: `✨ ` amber bold role bullet; continuation aligns under it. */
function userLines(text: string, width: number): string[] {
  const bulletW = stringWidth(USER_BULLET)
  const inner = Math.max(8, width - bulletW)
  const wrapped = wrapWidth(text || '…', inner)
  return ['', ...wrapped.map((line, index) =>
    index === 0 ? theme.roleUser(USER_BULLET) + theme.roleUser(line) : ' '.repeat(bulletW) + theme.roleUser(line),
  )]
}

/** Assistant voice: `● ` body bullet + markdown; continuation indents. */
function assistantLines(text: string, width: number): string[] {
  const inner = Math.max(10, width - 2)
  const md = renderMarkdown(text || '…', inner)
  return ['', ...md.map((line, index) => (index === 0 ? theme.text(STATUS_BULLET) + line : MESSAGE_INDENT + line))]
}

function thoughtLines(row: TranscriptRow, ctx: FrameContext, width: number): string[] {
  const expanded = ctx.thoughtExpanded ?? false
  const elapsed = row.seconds ?? (row.startMs !== undefined ? Math.round((ctx.now - row.startMs) / 100) / 10 : 0)
  // Sealed + collapsed: one summary line (full text stays in the session log).
  if (row.seconds !== undefined && !expanded) {
    return ['', theme.subtle(STATUS_BULLET) + theme.placeholder(`已思考 ${row.seconds}s`)]
  }
  // Expanded (Ctrl+O): the full thinking text, live or sealed.
  if (expanded) {
    const head = row.seconds === undefined
      ? theme.subtle(`${SPIN[tickOf(row, ctx)] ?? SPIN[0]} 思考中 ${elapsed}s · Ctrl+O 折叠`)
      : theme.subtle(`✻ 思考过程 ${row.seconds}s · Ctrl+O 折叠`)
    const wrapped = wrapWidth(row.text || '（空）', Math.max(8, width - 4))
    return ['', head, ...wrapped.map((line) => theme.placeholder(MESSAGE_INDENT + '│ ' + line))]
  }
  // Streaming + collapsed: spinner + timer, last two wrapped lines as preview.
  const head = theme.subtle(`${SPIN[tickOf(row, ctx)] ?? SPIN[0]} 思考中 ${elapsed}s · Ctrl+O 展开`)
  const wrapped = wrapWidth(row.text || '', Math.max(8, width - 4))
  const tail = wrapped.slice(-2).map((line) => theme.placeholder(MESSAGE_INDENT + '⋯ ' + line))
  return ['', head, ...tail]
}

function tickOf(row: TranscriptRow, ctx: FrameContext): number {
  return row.startMs !== undefined ? Math.floor((ctx.now - row.startMs) / 80) % SPIN.length : 0
}

/** Tool run: backgrounded card; status mark + counts in the frame. */
function toolCard(row: TranscriptRow, width: number): string[] {
  const name = row.tool ?? 'tool'
  const style: BoxStyle = { bg: theme.panel, border: theme.panelBorder }
  if (row.diff) {
    const mark = row.status === 'failed' ? theme.fail(FAILURE_MARK) : theme.ok(SUCCESS_MARK)
    const title = mark + theme.strong(`${name} ${row.diff.path}`)
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
    return ['', ...boxed(content, width, { ...style, title }, { right })]
  }
  const mark =
    row.status === 'running' ? theme.primary('⠋') : row.status === 'failed' ? theme.fail(FAILURE_MARK) : theme.ok(SUCCESS_MARK)
  const suffix = row.status === 'running' ? theme.subtle(' …') : ''
  const title = mark + theme.strong(name) + suffix
  const wrapped = wrapWidth(row.text || '', Math.max(8, width - 8))
  const content = wrapped.slice(0, 3).map((line) => theme.subtle(line))
  return ['', ...boxed(content, width, { ...style, title })]
}

function wrappedLines(text: string, width: number): string[] {
  return wrapWidth(text, width)
}

/** Boxed editor, kimi-style: primary rounded frame, `> ` prompt at column 2. */
function inputBox(text: string, width: number): string[] {
  const w = Math.max(20, width)
  const style: BoxStyle = { bg: (t) => t, border: theme.primary }
  const body = text !== '' ? text : theme.placeholder('说点什么…')
  return [boxTop(w, style), boxLine('> ' + body, w, style), boxBottom(w, style)]
}

/** Two-line plain status footer (kimi footer.ts): state/route/cwd + hints/context. */
function footerLines(ctx: FrameContext, width: number): string[] {
  const state = ctx.channel.runState
  const route = ctx.route
  const usage = ctx.usage
  const compacting = ctx.channel.compacting
  const badge = compacting
    ? theme.subtle('◌ 压缩中…')
    : state === 'thinking'
      ? theme.subtle('⠋ 思考中…')
      : state === 'working'
        ? theme.subtle('⏺ 执行工具…')
        : ctx.connecting
          ? theme.subtle('○ 连接中…')
          : ''
  const routeText = route
    ? theme.text(`${route.provider}/${route.model}${route.reasoningEffort ? `(${route.reasoningEffort})` : ''}`)
    : ''
  // M3/M4 status slots: title · yolo/policy · git branch — all best-effort,
  // all truncated by the gutter guard. Empty slots vanish, never blank gaps.
  const titleText = ctx.title ? theme.text(`「${ctx.title}」`) : ''
  const modeText = ctx.yolo ? theme.warn('yolo') : ctx.policy === 'never' ? theme.warn('never') : ''
  const branchText = ctx.branch ? theme.muted(`⑂ ${ctx.branch}`) : ''
  const dir = theme.muted(short(ctx.cwd))
  const line1 = [badge, routeText, titleText, modeText, dir, branchText].filter((part) => part !== '').join(theme.subtle('  '))

  const context =
    usage.messages > 0
      ? `context: ↑${fmtTokens(usage.input)} ↓${fmtTokens(usage.output)}${usage.reasoning > 0 ? ` ✻${fmtTokens(usage.reasoning)}` : ''}`
      : ''
  const hintText = theme.muted(HINT)
  let line2: string
  if (context !== '') {
    const contextText = theme.text(context)
    const ctxW = stringWidth(contextText)
    const avail = Math.max(0, width - 2 - ctxW)
    const shownHint = stringWidth(hintText) > avail ? truncateWidth(hintText, avail) : hintText
    const pad = Math.max(0, width - 2 - stringWidth(shownHint) - ctxW)
    line2 = shownHint + ' '.repeat(pad) + contextText
  } else {
    line2 = hintText
  }
  return [gutterLine(line1, width), gutterLine(line2, width)]
}

/** 1-cell gutter strip (kimi CHROME_GUTTER): ` content ` within `width`. */
function gutterLine(content: string, width: number): string {
  return ' ' + truncateWidth(content, width - 2) + ' '
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
