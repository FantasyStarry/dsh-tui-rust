/**
 * Theme tokens — the semantic color layer between the channel/view and raw
 * SGR (adapted from kimi-code's dark `ColorPalette`, MoonshotAI/kimi-code
 * `src/tui/theme/colors.ts`): blue primary (#4FA8FF), amber user role
 * (#FFCB6B), gray text scale, teal accent. Views never write escape codes
 * directly; they pick a token by MEANING.
 *
 * Three fidelity tiers, chosen once at import:
 * - truecolor (COLORTERM=truecolor/24bit, Windows Terminal, VS Code): the
 *   exact palette.
 * - 256-color: the closest xterm-256 approximations.
 * - NO_COLOR: plain text.
 *
 * Paint discipline: every paint is PAIRED with a PRECISE close — fg
 * `\x1b[39m`, bold/dim `\x1b[22m`, italic `\x1b[23m`, bg `\x1b[49m`. Never a
 * bare `\x1b[0m`: a blanket reset kills an outer style when paints nest
 * (cards wrap painted content, e.g. a bg-filled code card). Because closes
 * are precise, paints compose — `strong(subtle(x))` is bold-dim text.
 * Width math is always terminal cells, never string.length.
 */

export type Paint = (text: string) => string

const env = process.env
const noColor = env['NO_COLOR'] !== undefined
const truecolor =
  env['COLORTERM'] === 'truecolor' ||
  env['COLORTERM'] === '24bit' ||
  env['WT_SESSION'] !== undefined ||
  (env['TERM_PROGRAM'] !== undefined && env['TERM_PROGRAM'] !== 'apple_terminal')

function pair(open: string, close: string): Paint {
  return (text: string) => `${open}${text}${close}`
}

/** Truecolor foreground painter. */
function rgb(r: number, g: number, b: number): Paint {
  return pair(`\x1b[38;2;${r};${g};${b}m`, '\x1b[39m')
}

/** Truecolor background painter. */
function bg(r: number, g: number, b: number): Paint {
  return pair(`\x1b[48;2;${r};${g};${b}m`, '\x1b[49m')
}

/** 256-color foreground painter. */
function c256(n: number): Paint {
  return pair(`\x1b[38;5;${n}m`, '\x1b[39m')
}

/** 256-color background painter. */
function bg256(n: number): Paint {
  return pair(`\x1b[48;5;${n}m`, '\x1b[49m')
}

export interface PaletteSpec {
  /** Brand / interactive blue: selector pointers, focused editor border,
   *  code inline, welcome box, link-ish accents. */
  primary: Paint
  /** Secondary teal highlight. */
  accent: Paint
  /** primary + bold — dialog titles, selected rows, welcome wordmark. */
  title: Paint
  /** Default body text (assistant bullet, footer values, context). */
  text: Paint
  /** Secondary dim text (metadata, hints). */
  muted: Paint
  /** Faintest text (descriptions, scroll info). */
  subtle: Paint
  /** Emphasised near-white bold. */
  strong: Paint
  ok: Paint
  fail: Paint
  warn: Paint
  /** Violet accent (code numbers, streaming highlights). */
  live: Paint
  border: Paint
  /** Inline code + code-card frames. */
  code: Paint
  quote: Paint
  placeholder: Paint
  /** User-message role color: amber bold bullet + text. */
  roleUser: Paint
  /** Tool-card background fill + frame. */
  panel: Paint
  panelBorder: Paint
  /** Code-card background fill (frame stays `code`). */
  codeBg: Paint
}

/** kimi-code dark palette: blue brand, amber user role, gray scale. */
const truecolorPalette: PaletteSpec = {
  primary: rgb(79, 168, 255), // #4FA8FF
  accent: rgb(91, 192, 190), // #5BC0BE
  title: pair('\x1b[1m\x1b[38;2;79;168;255m', '\x1b[39m\x1b[22m'),
  text: rgb(224, 224, 224), // #E0E0E0
  muted: rgb(136, 136, 136), // #888888
  subtle: rgb(107, 107, 107), // #6B6B6B
  strong: pair('\x1b[1m\x1b[38;2;245;245;245m', '\x1b[39m\x1b[22m'), // #F5F5F5
  ok: rgb(78, 200, 126), // #4EC87E
  fail: rgb(232, 84, 84), // #E85454
  warn: rgb(232, 168, 56), // #E8A838
  live: rgb(189, 147, 249), // #BD93F9
  border: rgb(90, 90, 90), // #5A5A5A
  code: rgb(79, 168, 255), // #4FA8FF
  quote: rgb(136, 136, 136), // #888888
  placeholder: pair('\x1b[2;3m\x1b[38;2;107;107;107m', '\x1b[39m\x1b[23m\x1b[22m'), // dim italic
  roleUser: pair('\x1b[1m\x1b[38;2;255;203;107m', '\x1b[39m\x1b[22m'), // #FFCB6B bold
  panel: bg(38, 42, 48), // #262A30
  panelBorder: rgb(90, 90, 90), // #5A5A5A
  codeBg: bg(23, 26, 30), // #171A1E
}

/** xterm-256 approximations of the same semantics. */
const palette256: PaletteSpec = {
  primary: c256(75),
  accent: c256(79),
  title: pair('\x1b[1;38;5;75m', '\x1b[39m\x1b[22m'),
  text: c256(253),
  muted: c256(243),
  subtle: c256(241),
  strong: pair('\x1b[1;38;5;255m', '\x1b[39m\x1b[22m'),
  ok: c256(114),
  fail: c256(203),
  warn: c256(215),
  live: c256(177),
  border: c256(240),
  code: c256(75),
  quote: c256(243),
  placeholder: pair('\x1b[2;3;38;5;241m', '\x1b[39m\x1b[23m\x1b[22m'),
  roleUser: pair('\x1b[1;38;5;221m', '\x1b[39m\x1b[22m'),
  panel: bg256(236),
  panelBorder: c256(240),
  codeBg: bg256(234),
}

/** Plain-text fallback: structure only, no SGR at all. */
const plainPalette: PaletteSpec = {
  primary: (t) => t,
  accent: (t) => t,
  title: (t) => t,
  text: (t) => t,
  muted: (t) => t,
  subtle: (t) => t,
  strong: (t) => t,
  ok: (t) => t,
  fail: (t) => t,
  warn: (t) => t,
  live: (t) => t,
  border: (t) => t,
  code: (t) => t,
  quote: (t) => t,
  placeholder: (t) => t,
  roleUser: (t) => t,
  panel: (t) => t,
  panelBorder: (t) => t,
  codeBg: (t) => t,
}

const palette = noColor ? plainPalette : truecolor ? truecolorPalette : palette256

export const theme = palette

export type Theme = typeof theme