/**
 * Frame painter — Ink/pi-tui model with absolute addressing:
 *
 * The screen holds a growing static document (sealed transcript rows,
 * written once) and a trailing live block (growing rows + chrome). The
 * painter tracks the block's physical top row; everything above it is
 * history that the terminal scrolls into its own scrollback naturally.
 *
 * - **Flush** (stream lines): erase the current block, then APPEND the
 *   sealed lines and the new block sequentially from the block top —
 *   ordinary terminal printing. Overflowing the viewport scrolls the
 *   oldest rows into scrollback; the frame's trailing spacer keeps the
 *   input chrome pinned to the bottom line. Nothing is ever overwritten,
 *   so scrollback is append-only and duplication-free.
 * - **Diff**: same-length blocks are rewritten in place per changed line
 *   (CUP + EL), no scrolling, no relative cursor arithmetic to drift.
 *
 * Every frame is wrapped in CSI 2026 synchronized output (no tearing).
 */

import { truncateWidth } from './width.js'

const SYNC_START = '\x1b[?2026h'
const SYNC_END = '\x1b[?2026l'
const CLEAR_LINE = '\x1b[2K'

export interface CursorPlacement {
  /** Rows above the bottom of the live block (0 = last row). */
  readonly fromEnd: number
  /** 1-based column for the cursor (CHA). */
  readonly col: number
}

/** Absolute cursor position (1-based row/col) — immune to drift. */
function cup(row: number, col: number): string {
  return `\x1b[${Math.max(1, row)};${Math.max(1, col)}H`
}

export class Renderer {
  private last: string[] = []
  private lastWidth = 0
  private lastHeight = 0
  /** Physical viewport row (0-based) of the live block's first line. */
  private blockTop = 0

  constructor(
    private readonly stdout: NodeJS.WriteStream,
    private readonly getWidth: () => number,
    private readonly getHeight: () => number = () => 24,
  ) {}

  /**
   * Repaint the frame; no-op when nothing changed.
   *
   * `stream` lines are NEWLY SEALED history: they append to the document
   * ahead of the block, one terminal scroll per line past the viewport
   * bottom, so they end up in scrollback in log order and never come back.
   * A width change reflows (full repaint); a height change only re-derives
   * the block extent (the terminal reflows its own buffer).
   */
  render(live: readonly string[], stream: readonly string[] = [], cursor?: CursorPlacement): void {
    const width = Math.max(1, this.getWidth())
    const height = Math.max(1, this.getHeight())
    const resized = width !== this.lastWidth || height !== this.lastHeight
    this.lastWidth = width
    this.lastHeight = height
    // Clamp defensively: a block taller than the viewport cannot paint
    // without scroll — keep the tail (the chrome side) and drop the top.
    const frame = live.slice(Math.max(0, live.length - height)).map((line) => truncateToCells(line, width))

    if (stream.length > 0 || resized || frame.length !== this.last.length) {
      this.appendPaint(out => {
        // Erase the previous block rows in place (no shifting). Rows above
        // the block are static history — never touched.
        const prevK = Math.min(this.last.length, height)
        const eraseFrom = Math.max(0, Math.min(this.blockTop, height - 1))
        const eraseTo = Math.min(this.blockTop + prevK, height)
        for (let row = eraseFrom; row < eraseTo; row++) {
          out.push(cup(row + 1, 1), CLEAR_LINE)
        }
        // Append the sealed lines, then the block, as one downward flow.
        // A newline at the bottom row scrolls the terminal: the top row
        // (always the oldest static line) sediments into scrollback.
        let row = Math.max(0, Math.min(this.blockTop, height - 1))
        for (const line of stream) {
          // At the bottom row each newline scrolls one line in; the cursor
          // stays parked at the bottom while the sealed lines flow through.
          out.push(cup(row + 1, 1), CLEAR_LINE, truncateToCells(line, width), '\r\n')
          if (row < height - 1) row++
        }
        // The block starts where the static flow ended; every scroll DURING
        // the block write shifts the block's top up one row — the tracked
        // top must fold those in or the next erase misses the block head.
        let top = row
        for (let i = 0; i < frame.length; i++) {
          out.push(cup(row + 1, 1), CLEAR_LINE, frame[i] ?? '')
          if (i < frame.length - 1) {
            out.push('\r\n')
            if (row >= height - 1) top = Math.max(0, top - 1)
            else row++
          }
        }
        this.blockTop = top
      }, frame, cursor)
      return
    }

    if (sameFrame(frame, this.last)) return

    // Steady state: same block size, no flush — rewrite only changed rows.
    this.appendPaint(out => {
      let firstDiff = 0
      while (firstDiff < frame.length && frame[firstDiff] === this.last[firstDiff]) firstDiff++
      const top = Math.max(0, Math.min(this.blockTop, height - frame.length))
      for (let i = firstDiff; i < frame.length; i++) {
        out.push(cup(top + i + 1, 1), CLEAR_LINE, frame[i] ?? '')
      }
    }, frame, cursor)
  }

  /** Wrap one paint in the synchronized-output envelope and track the frame. */
  private appendPaint(paint: (out: string[]) => void, frame: readonly string[], cursor?: CursorPlacement): void {
    const out: string[] = [SYNC_START]
    paint(out)
    if (cursor && frame.length > 0) {
      // `fromEnd` counts from the block BOTTOM (0 = last row).
      const top = Math.max(0, this.blockTop)
      const row = top + Math.max(0, Math.min(frame.length - 1 - cursor.fromEnd, frame.length - 1))
      out.push(cup(row + 1, cursor.col))
    }
    out.push(SYNC_END)
    this.stdout.write(out.join(''))
    this.last = [...frame]
  }

  /** Erase the live block on teardown; static history stays in scrollback. */
  dispose(): void {
    const height = Math.max(1, this.getHeight())
    const top = Math.max(0, Math.min(this.blockTop, height - 1))
    this.stdout.write(cup(top + 1, 1) + '\x1b[0J')
    this.last = []
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
