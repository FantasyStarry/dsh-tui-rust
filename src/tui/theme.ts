/**
 * Theme tokens — the semantic color layer between the channel/view and raw
 * SGR (pi's token-set idea, shrunk to what the skeleton uses). Views never
 * write escape codes directly; they pick a token by MEANING.
 *
 * Three fidelity tiers, chosen once at import:
 * - truecolor (COLORTERM=truecolor/24bit, Windows Terminal, VS Code): the
 *   exact warm palette — Claude-coral brand on soft grays.
 * - 256-color: the closest xterm-256 approximations.
 * - NO_COLOR: plain text.
 *
 * Every paint is PAIRED (open + explicit close) so styles never leak across
 * fragments or lines.
 */

type Paint = (text: string) => string

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

/** 256-color foreground painter. */
function c256(n: number): Paint {
  return pair(`\x1b[38;5;${n}m`, '\x1b[39m')
}

function ansi(n: number): Paint {
  return pair(`\x1b[${n}m`, '\x1b[39m')
}

interface PaletteSpec {
  primary: Paint
  accent: Paint
  muted: Paint
  strong: Paint
  ok: Paint
  fail: Paint
  warn: Paint
  live: Paint
  selected: Paint
  border: Paint
  code: Paint
  quote: Paint
  placeholder: Paint
}

/** Warm Claude-adjacent palette: coral brand, teal info, soft gray chrome. */
const truecolorPalette: PaletteSpec = {
  primary: rgb(217, 119, 87), // #D97757 coral
  accent: rgb(107, 182, 194), // #6BB6C2 teal
  muted: rgb(139, 148, 158), // #8B949E gray
  strong: pair('\x1b[1m\x1b[38;2;230;237;243m', '\x1b[0m'), // near-white bold
  ok: rgb(152, 195, 121), // #98C379
  fail: rgb(224, 108, 117), // #E06C75
  warn: rgb(229, 192, 123), // #E5C07B
  live: rgb(198, 120, 221), // #C678DD
  selected: pair('\x1b[1m\x1b[38;2;230;237;243;48;2;52;58;64m', '\x1b[0m'),
  border: rgb(63, 68, 74), // #3F444A subtle frame
  code: rgb(121, 184, 255), // #79B8FF
  quote: rgb(160, 168, 179), // #A0A8B3
  placeholder: pair('\x1b[2;3m\x1b[38;2;139;148;158m', '\x1b[0m'), // dim italic
}

/** xterm-256 approximations of the same semantics. */
const palette256: PaletteSpec = {
  primary: c256(209),
  accent: c256(80),
  muted: c256(245),
  strong: pair('\x1b[1;38;5;255m', '\x1b[0m'),
  ok: c256(114),
  fail: c256(203),
  warn: c256(215),
  live: c256(141),
  selected: pair('\x1b[1;38;5;255;48;5;238m', '\x1b[0m'),
  border: c256(239),
  code: c256(117),
  quote: c256(146),
  placeholder: pair('\x1b[2;3;38;5;245m', '\x1b[0m'),
}

/** Plain-text fallback: structure only, no SGR at all. */
const plainPalette: PaletteSpec = {
  primary: (t) => t,
  accent: (t) => t,
  muted: (t) => t,
  strong: (t) => t,
  ok: (t) => t,
  fail: (t) => t,
  warn: (t) => t,
  live: (t) => t,
  selected: (t) => t,
  border: (t) => t,
  code: (t) => t,
  quote: (t) => t,
  placeholder: (t) => t,
}

const palette = noColor ? plainPalette : truecolor ? truecolorPalette : palette256

export const theme = palette

export type Theme = typeof theme
