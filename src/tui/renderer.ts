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

import { truncateWidth } from './width.js'

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
  private lastWidth = 0
  /**
   * Where placeCursor left the terminal cursor, counted from the bottom of
   * `last` (0 = last row). The repaint math is relative to THIS park
   * position — placing the cursor mid-frame (the input row) shifts every
   * subsequent repaint, and ignoring it smears the chrome down the screen.
   */
  private cursorFromEnd = 0

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
      const parkRow = this.last.length - 1 - this.cursorFromEnd
      if (parkRow > 0) out.push(`\x1b[${parkRow}A`)
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
      const stale = this.last.length - written
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
    // Move the cursor from its actual park position to the first changed
    // row. Pure-append growth (firstDiff below the old region) falls out as
    // a negative move — step DOWN, or the first new line overwrites the old
    // last row.
    const parkRow = this.last.length - 1 - this.cursorFromEnd
    const move = parkRow - firstDiff
    if (move > 0) out.push(`\x1b[${move}A`)
    else if (move < 0) out.push(`\x1b[${-move}B`)
    out.push('\r')

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
    if (!cursor || frameLength === 0) {
      this.cursorFromEnd = 0
      return
    }
    const up = Math.max(0, Math.min(cursor.fromEnd, frameLength - 1))
    this.cursorFromEnd = up
    if (up > 0) out.push(`\x1b[${up}A`)
    out.push(`\x1b[${Math.max(1, cursor.col)}G`)
  }

  /** Restore terminal state on teardown. */
  dispose(): void {
    this.stdout.write('\r' + CLEAR_LINE + '\x1b[0J')
    this.last = []
    this.cursorFromEnd = 0
  }
}

/** Hard-guard every row to the terminal width so the diff never miscounts. */
function truncateToCells(line: string, width: number): string {
  return truncateWidth(line, width)
}

function sameFrame(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
