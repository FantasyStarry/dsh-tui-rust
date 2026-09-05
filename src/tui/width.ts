/**
 * Terminal display width, built on `get-east-asian-width` (the same
 * dependency pi-tui uses) — CJK blocks, emoji and fullwidth forms are
 * multi-cell; combining marks are zero.
 *
 * One deliberate override on top of the library default: `…` (U+2026) and
 * `⋯` (U+22EF) count as TWO cells. They are East-Asian-Width "ambiguous" —
 * the library (like ConPTY's internal table) says narrow, but CJK terminals
 * render them double-cell, so a row padded with our count wraps in the
 * terminal (or vice versa). Rows that must occupy EXACTLY the terminal
 * width therefore never contain these glyphs at all — see `asciiEllipses`
 * (the box/gutter primitives apply it) — and free-form transcript rows can
 * tolerate the 1-cell drift either way. Never use `string.length`.
 */

import { eastAsianWidth } from 'get-east-asian-width'

/** Ambiguous-width ellipses rendered double-cell by CJK terminals. */
const FORCE_WIDE = new Set([0x2026, 0x22ef])

/**
 * Strip the ambiguous ellipses from text that will be padded to EXACTLY the
 * terminal width (box cards, editor box, footer gutter). These rows must
 * occupy the same number of cells under every width table: the app counts
 * `…` as 2, ConPTY's table counts 1 (and re-emits a fill space), while a
 * CJK-configured Windows Terminal renders 2 — the row lands one cell over
 * and wraps, eating the row below it (the "输入框底边框消失" bug). Free-form
 * transcript rows are exempt: nothing aligns against their trailing edge.
 */
export function asciiEllipses(text: string): string {
  if (!text.includes('…') && !text.includes('⋯')) return text
  return text.replaceAll('…', '...').replaceAll('⋯', '...')
}

export function charWidth(code: number): number {
  if (code === 0) return 0
  // Combining marks and zero-width joiners/render-blockers render zero cells.
  if ((code >= 0x0300 && code <= 0x036f) || code === 0x200b || code === 0xfeff) return 0
  if (FORCE_WIDE.has(code)) return 2
  return eastAsianWidth(code) === 2 ? 2 : 1
}

export function stringWidth(text: string): number {
  let width = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\x1b') {
      const end = csiEnd(text, i + 1)
      if (end !== -1) {
        i = end
        continue
      }
    }
    const code = text.codePointAt(i) ?? 0
    width += charWidth(code)
    if (code > 0xffff) i++
  }
  return width
}

/** Truncate to at most `max` terminal cells, appending `tail` when cut. */
export function truncateWidth(text: string, max: number, tail = ''): string {
  if (stringWidth(text) <= max) return text
  const budget = Math.max(0, max - stringWidth(tail))
  let out = ''
  let used = 0
  let clipped = false
  let hadEscape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? ''
    if (ch === '\x1b') {
      const end = csiEnd(text, i + 1)
      if (end !== -1) {
        hadEscape = true
        out += text.slice(i, end + 1)
        i = end
        continue
      }
    }
    const code = text.codePointAt(i) ?? 0
    const w = charWidth(code)
    if (used + w > budget) {
      clipped = true
      break
    }
    out += String.fromCodePoint(code)
    used += w
    if (code > 0xffff) i++
  }
  return out + (clipped && hadEscape ? '\x1b[39m\x1b[22m\x1b[23m' : '') + tail
}

/** Return the final index of a CSI escape sequence, or -1 for plain ESC. */
function csiEnd(text: string, start: number): number {
  if (text[start] !== '[') return -1
  for (let i = start + 1; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0x40 && code <= 0x7e) return i
  }
  return -1
}

/** Word-ish wrap to terminal cells; hard-splits runs longer than `width`. */
export function wrapWidth(text: string, width: number): string[] {
  if (width <= 0) return [text]
  const lines: string[] = []
  for (const rawLine of text.split('\n')) {
    let current = ''
    let used = 0
    for (const word of rawLine.split(/(\s+)/u)) {
      const wordWidth = stringWidth(word)
      if (used + wordWidth <= width) {
        current += word
        used += wordWidth
        continue
      }
      if (wordWidth > width) {
        // An overlong run always hard-splits, including after a partially
        // filled line. Flush that prefix first so no emitted row exceeds the
        // requested width (`a abcdefghij`, width 5 used to lose this rule).
        if (current) {
          lines.push(current)
          current = ''
          used = 0
        }
        for (const ch of word) {
          const w = charWidth(ch.codePointAt(0) ?? 0)
          if (used > 0 && used + w > width) {
            lines.push(current)
            current = ch
            used = w
          } else {
            current += ch
            used += w
          }
        }
        continue
      }
      if (current) lines.push(current)
      current = word.trimStart()
      used = stringWidth(current)
    }
    lines.push(current)
  }
  return lines
}
