/**
 * Frame painter with differential output — the pi-tui strategy 3:
 * locate the first changed line, clear to the end of screen, repaint only
 * the changed tail. Every frame is wrapped in CSI 2026 synchronized output
 * so the terminal never shows a torn frame (flicker-free streaming).
 *
 * The skeleton paints a single live region on the main screen; sealing
 * settled transcript lines into terminal scrollback (the inline mode of
 * pi / dsh-TUI) is the next renderer milestone — see docs/adr/0001.
 */

import { stringWidth } from './width.js'

const SYNC_START = '\x1b[?2026h'
const SYNC_END = '\x1b[?2026l'
const CLEAR_LINE = '\x1b[2K'

export interface CursorPlacement {
  /** Rows above the bottom of the live frame (0 = last row). */
  readonly fromEnd: number
  /** 1-based column for the cursor (CHA). */
  readonly col: number
}

export class Renderer {
  private last: string[] = []
  private lastRows = 0
  private lastWidth = 0

  constructor(
    private readonly stdout: NodeJS.WriteStream,
    private readonly getWidth: () => number,
  ) {}

  /**
   * Repaint the frame; no-op when nothing changed.
   *
   * `stream` lines are NEWLY SEALED history: written once at the top of the
   * tracked region (below previously sealed content, above the live rows),
   * then never tracked again — the overflow past the screen bottom scrolls
   * into the terminal's own scrollback. The live frame is fully repainted in
   * the same synchronized block, and afterwards only the live rows are
   * diff-tracked. A terminal-width change forces the same full repaint
   * (per-row diffs would land on stale columns).
   *
   * `cursor` places the terminal cursor inside the frame (the input row) —
   * the painter would otherwise leave it parked on the bottom row.
   */
  render(live: readonly string[], stream: readonly string[] = [], cursor?: CursorPlacement): void {
    const width = Math.max(1, this.getWidth())
    const frame = live.map((line) => truncateToCells(line, width))
    const forceFull = stream.length > 0 || width !== this.lastWidth
    if (!forceFull && sameFrame(frame, this.last) && frame.length === this.last.length) return

    if (forceFull) {
      const out: string[] = [SYNC_START]
      const n = this.last.length
      if (n > 1) out.push(`\x1b[${n - 1}A`)
      out.push('\r')
      for (const line of stream) {
        out.push(CLEAR_LINE, truncateToCells(line, width), '\r\n')
      }
      for (const line of frame) {
        out.push(CLEAR_LINE, line, '\r\n')
      }
      // Clear whatever is left of the old region below the new frame — the
      // seal flush often SHRINKS the live region (previous turn's rows left),
      // and uncleared rows kept ghost copies of the chrome on screen.
      const written = stream.length + frame.length
      const stale = n - written
      if (stale > 0) out.push(CLEAR_LINE, '\x1b[0J')
      if (frame.length > 0) out.push('\x1b[1A')
      this.placeCursor(out, frame.length, cursor)
      this.stdout.write(out.join(''))
      this.last = [...frame]
      this.lastWidth = width
      return
    }

    let firstDiff = 0
    while (
      firstDiff < frame.length &&
      firstDiff < this.last.length &&
      frame[firstDiff] === this.last[firstDiff]
    ) {
      firstDiff++
    }

    const out: string[] = [SYNC_START]
    // Park the cursor at the first changed line of the previous frame.
    const up = this.last.length - 1 - firstDiff + this.trailingRows(this.last)
    if (up > 0) out.push(`\x1b[${up}A`)
    out.push('\r')
    // Pure-append growth (prefix identical, lines added below the old
    // frame): the cursor is parked ON the old last line — step down one
    // row before painting, or the first new line overwrites it.
    if (firstDiff >= this.last.length && this.last.length > 0) {
      out.push('\x1b[1B')
    }

    for (let i = firstDiff; i < frame.length; i++) {
      out.push(CLEAR_LINE, frame[i] ?? '', '\r\n')
    }
    // Clear stale lines below the new frame (shrink case) and park the
    // cursor on the final input line.
    const stale = this.last.length - frame.length
    if (stale > 0) out.push(CLEAR_LINE, '\x1b[0J')
    if (frame.length > 0) out.push('\x1b[1A')
    this.placeCursor(out, frame.length, cursor)
    out.push(SYNC_END)

    this.stdout.write(out.join(''))
    this.last = [...frame]
    this.lastWidth = width
  }

  /** Move the cursor to its in-frame home (the input row) after painting. */
  private placeCursor(out: string[], frameLength: number, cursor?: CursorPlacement): void {
    if (!cursor || frameLength === 0) return
    const up = Math.max(0, Math.min(cursor.fromEnd, frameLength - 1))
    if (up > 0) out.push(`\x1b[${up}A`)
    out.push(`\x1b[${Math.max(1, cursor.col)}G`)
  }

  /** Restore terminal state on teardown. */
  dispose(): void {
    this.stdout.write('\r' + CLEAR_LINE + '\x1b[0J')
    this.last = []
  }

  private trailingRows(_frame: readonly string[]): number {
    return 0
  }
}

/** Hard-guard every row to the terminal width so the diff never miscounts. */
function truncateToCells(line: string, width: number): string {
  if (stringWidth(line) <= width) return line
  let out = ''
  let used = 0
  for (const ch of line) {
    const code = ch.codePointAt(0) ?? 0
    const w = code >= 0x1100 && isWideRange(code) ? 2 : 1
    if (used + w > width) break
    out += ch
    used += w
  }
  return out
}

function isWideRange(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

function sameFrame(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
