/**
 * Box primitives — the layout atoms for the card/bubble visual language.
 * A box is a full-width frame (rounded corners) whose body is background-
 * filled, so cards read as solid panels against the terminal background.
 *
 * Nesting rule: the frame characters are painted INSIDE the background
 * wrapper (`bg(border('╭') + … + border('╮'))`), so corners keep the border
 * color while the whole line carries the card fill. This only works because
 * every theme paint closes with a PRECISE reset (see theme.ts) — a blanket
 * `\x1b[0m` inside would punch the fill out.
 *
 * Width math is always terminal cells; content is truncated at the card edge
 * (never hard-wrapped here — callers pre-wrap with wrapSpans/wrapWidth).
 */

import { stringWidth, truncateWidth } from './width.js'
import type { Paint } from './theme.js'

export interface BoxStyle {
  /** Background fill painted across the whole box (body + borders). */
  readonly bg: Paint
  /** Foreground for the frame characters. */
  readonly border: Paint
  /** Optional title embedded in the top border (plain or pre-painted). */
  readonly title?: string
  /** Applied to `title` when it is plain; pass pre-painted titles and omit. */
  readonly titlePaint?: Paint
}

const TL = '╭'
const TR = '╮'
const BL = '╰'
const BR = '╯'
const H = '─'
const V = '│'

function inner(width: number): number {
  return Math.max(2, width - 2)
}

/** Top border: `╭─ title ──── [right]─╮`. `right` (pre-painted) hugs the corner. */
export function boxTop(width: number, style: BoxStyle, right?: string): string {
  const innerW = inner(width)
  let label = ''
  if (style.title) {
    const t = style.titlePaint ? style.titlePaint(style.title) : style.title
    label = `─ ${t} `
  }
  const rightPart = right === undefined ? '' : ` ${right}`
  const labelW = stringWidth(label)
  const rightW = stringWidth(rightPart)
  const fill = H.repeat(Math.max(1, innerW - labelW - rightW))
  return style.bg(style.border(TL) + label + fill + rightPart + style.border(TR))
}

/** Bottom border: `╰──[hint]───╯`. `hint` is pre-painted; truncated to fit. */
export function boxBottom(width: number, style: BoxStyle, hint?: string): string {
  const innerW = inner(width)
  let h = hint === undefined ? '' : `─ ${hint} `
  if (stringWidth(h) > innerW) h = truncateWidth(h, innerW)
  const fill = H.repeat(Math.max(1, innerW - stringWidth(h)))
  return style.bg(style.border(BL) + h + fill + style.border(BR))
}

/**
 * Body line: `│ content …pad… │` with the whole line background-filled.
 * `fill` overrides the box bg (used for full-row selection highlights).
 */
export function boxLine(content: string, width: number, style: BoxStyle, fill?: Paint): string {
  const innerW = inner(width)
  let c = content
  if (stringWidth(c) > innerW - 2) c = truncateWidth(c, innerW - 2)
  const pad = Math.max(0, innerW - 2 - stringWidth(c))
  const bg = fill ?? style.bg
  return bg(style.border(V) + ' ' + c + ' '.repeat(pad) + ' ' + style.border(V))
}

/** A complete box: top border → body lines → bottom border (optional hint). */
export function boxed(
  content: readonly string[],
  width: number,
  style: BoxStyle,
  opts?: { readonly hint?: string; readonly right?: string },
): string[] {
  return [boxTop(width, style, opts?.right), ...content.map((line) => boxLine(line, width, style)), boxBottom(width, style, opts?.hint)]
}
