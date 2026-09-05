/**
 * Convert untrusted terminal-facing input to plain text.
 *
 * Session/model/tool/editor values cross this boundary before Orca applies
 * its own SGR. Newlines remain semantic layout separators and tabs become
 * spaces; every other C0/C1 control is removed. Unterminated control strings
 * consume the remaining input so a later chunk cannot complete an escape
 * sequence after the text has reached stdout.
 */
export function cleanText(text: string): string {
  let out = ''
  for (let i = 0; i < text.length;) {
    const code = text.charCodeAt(i)

    if (code === 0x1b) {
      i = skipEscape(text, i)
      continue
    }
    if (code === 0x9b) {
      i = skipCsi(text, i + 1)
      continue
    }
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      i = skipControlString(text, i + 1, code === 0x9d)
      continue
    }
    if (code === 0x0a) {
      out += '\n'
      i++
      continue
    }
    if (code === 0x09) {
      out += ' '
      i++
      continue
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      i++
      continue
    }

    const point = text.codePointAt(i) ?? code
    out += String.fromCodePoint(point)
    i += point > 0xffff ? 2 : 1
  }
  return out
}

/** Plain text constrained to one terminal row. */
export function cleanLine(text: string): string {
  return cleanText(text).replaceAll('\n', ' ')
}

function skipEscape(text: string, esc: number): number {
  const next = text.charCodeAt(esc + 1)
  if (Number.isNaN(next)) return text.length
  if (next === 0x5b) return skipCsi(text, esc + 2) // CSI: ESC [
  if (next === 0x5d) return skipControlString(text, esc + 2, true) // OSC: ESC ]
  if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
    return skipControlString(text, esc + 2, false) // DCS/SOS/PM/APC
  }
  if (next >= 0x20 && next <= 0x2f) {
    for (let i = esc + 2; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (code >= 0x30 && code <= 0x7e) return i + 1
      if (code < 0x20 || code > 0x2f) return i
    }
    return text.length
  }
  // Two-byte Fe escapes (RIS, IND, NEL, HTS, keypad modes, ...).
  if (next >= 0x30 && next <= 0x7e) return esc + 2
  return esc + 1
}

function skipCsi(text: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0x40 && code <= 0x7e) return i + 1
    if (code < 0x20 || code > 0x3f) return i
  }
  return text.length
}

function skipControlString(text: string, start: number, bellTerminates: boolean): number {
  for (let i = start; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (bellTerminates && code === 0x07) return i + 1
    if (code === 0x9c) return i + 1
    if (code === 0x1b && text.charCodeAt(i + 1) === 0x5c) return i + 2
  }
  return text.length
}
