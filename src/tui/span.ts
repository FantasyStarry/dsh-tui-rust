/**
 * Styled text spans — the layout primitive between markdown/highlight and
 * the frame. A span carries plain text plus an optional theme paint; layout
 * (wrap/truncate) works on spans, so SGR state never needs tracking: paint
 * wraps each emitted fragment and every line implicitly resets at its end
 * (the renderer's width guard tolerates the escapes as zero-width).
 */

import { charWidth } from './width.js'

export interface Span {
  readonly text: string
  readonly paint?: (text: string) => string
}

export function spansWidth(spans: readonly Span[]): number {
  let width = 0
  for (const span of spans) {
    for (const ch of span.text) width += charWidth(ch.codePointAt(0) ?? 0)
  }
  return width
}

/** Render spans to one line (no wrapping — clip with an ellipsis tail). */
export function renderSpans(spans: readonly Span[], width: number, ellipsis = '…'): string {
  // Fast path: everything fits — paint each span as one unit.
  if (spansWidth(spans) <= width) {
    let out = ''
    for (const span of spans) {
      out += span.paint ? span.paint(span.text) : span.text
    }
    return out
  }
  // Clip path: emit chars (per-char paints stay balanced) up to the budget,
  // then a precise fg/bold/italic reset so no style leaks past the ellipsis —
  // and crucially no background reset, so a surrounding card fill survives.
  const tailW = charWidth(ellipsis.codePointAt(0) ?? 0)
  const budget = Math.max(0, width - tailW)
  let out = ''
  let used = 0
  outer: for (const span of spans) {
    const paint = span.paint
    for (const ch of span.text) {
      const w = charWidth(ch.codePointAt(0) ?? 0)
      if (used + w > budget) break outer
      out += paint ? paint(ch) : ch
      used += w
    }
  }
  return out + '\x1b[39m\x1b[22m\x1b[23m' + ellipsis
}

/** Word-wrap styled spans to `width` cells with a fixed leading `indent`. */
export function wrapSpans(spans: readonly Span[], width: number, indent = ''): string[] {
  const usable = Math.max(4, width - indent.length)
  const lines: string[] = []
  let current: string[] = []
  let currentOut = ''
  let used = 0

  const flush = (): void => {
    lines.push(indent + currentOut)
    current = []
    currentOut = ''
    used = 0
  }
  const emitFragment = (text: string, paint?: (text: string) => string): void => {
    current.push(paint ? paint(text) : text)
    currentOut += paint ? paint(text) : text
    for (const ch of text) used += charWidth(ch.codePointAt(0) ?? 0)
  }

  for (const span of spans) {
    const words = span.text.split(/(\s+)/u)
    for (const word of words) {
      if (word === '') continue
      const isSpace = /^\s+$/u.test(word)
      const wordWidth = [...word].reduce((acc, ch) => acc + charWidth(ch.codePointAt(0) ?? 0), 0)

      if (isSpace) {
        if (used > 0 && used + wordWidth <= usable) {
          emitFragment(word, span.paint)
        }
        continue
      }
      if (wordWidth <= usable && used + wordWidth <= usable) {
        emitFragment(word, span.paint)
        continue
      }
      if (wordWidth > usable) {
        // Hard-split an unbreakable run across lines, char by char.
        for (const ch of word) {
          const w = charWidth(ch.codePointAt(0) ?? 0)
          if (used + w > usable) flush()
          emitFragment(ch, span.paint)
        }
        continue
      }
      flush()
      emitFragment(word, span.paint)
    }
  }
  if (current.length > 0 || lines.length === 0) flush()
  return lines
}
