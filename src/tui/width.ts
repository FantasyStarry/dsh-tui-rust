/**
 * Terminal display width. The skeleton uses a pragmatic East-Asian-width
 * approximation (CJK blocks are double-width, combining marks are zero).
 * Production must swap in `get-east-asian-width` (the same dependency pi-tui
 * uses) — emoji, variation selectors and fullwidth forms all matter for a
 * Chinese-first TUI. Never use `string.length` for layout.
 */

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK Radicals .. CJK Symbols
  [0x3041, 0x33ff], // Hiragana .. CJK Compatibility
  [0x3400, 0x4dbf], // CJK Ext A
  [0x4e00, 0x9fff], // CJK Unified
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe30, 0xfe4f], // CJK Compatibility Forms
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6],
  [0x20000, 0x2fffd], // CJK Ext B..
  [0x30000, 0x3fffd],
]

export function charWidth(code: number): number {
  if (code === 0) return 0
  // Combining marks and most zero-width joiners render zero cells.
  if ((code >= 0x0300 && code <= 0x036f) || code === 0x200b || code === 0xfeff) return 0
  for (const [lo, hi] of WIDE_RANGES) {
    if (code >= lo && code <= hi) return 2
  }
  return 1
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
  return out + (clipped && hadEscape ? '\x1b[0m' : '') + tail
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
      if (wordWidth > width && stringWidth(current) === 0) {
        // Single unbreakable run longer than the line: hard split.
        for (const ch of word) {
          const w = charWidth(ch.codePointAt(0) ?? 0)
          if (used + w > width) {
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
