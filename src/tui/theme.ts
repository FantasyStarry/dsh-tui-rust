/**
 * Theme tokens — the semantic color layer between the channel/view and raw
 * SGR (pi's token-set idea, expanded for the layered card/bubble language).
 * Views never write escape codes directly; they pick a token by MEANING.
 *
 * Three fidelity tiers, chosen once at import:
 * - truecolor (COLORTERM=truecolor/24bit, Windows Terminal, VS Code): the
 *   full palette — coral brand, teal info, layered background fills.
 * - 256-color: the closest xterm-256 approximations.
 * - NO_COLOR: plain text.
 *
 * Paint discipline: every paint is PAIRED with a PRECISE close — fg
 * `\x1b[39m`, bold/dim `\x1b[22m`, italic `\x1b[23m`, bg `\x1b[49m`. Never a
 * bare `\x1b[0m`: a blanket reset kills an outer background when paints nest
 * (a bg-filled card wrapping painted content), which would punch holes in the
 * card fill. Width math is always terminal cells, never string.length.
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

/** Background + foreground combined (used by selected rows / fills). */
function comb(open: string, close: string): Paint {
  return pair(open, close)
}

export interface PaletteSpec {
  primary: Paint
  accent: Paint
  muted: Paint
  /** Dimmer than muted — tertiary / metadata. */
  subtle: Paint
  strong: Paint
  ok: Paint
  fail: Paint
  warn: Paint
  /** Streaming / thinking activity. */
  live: Paint
  /** Full-row highlight (picker selection). */
  selected: Paint
  border: Paint
  code: Paint
  quote: Paint
  placeholder: Paint
  /** User-message bubble: background fill + frame color. */
  bubble: Paint
  bubbleBorder: Paint
  /** Neutral card (tool results): background fill + frame. */
  panel: Paint
  panelBorder: Paint
  /** Persistent chrome strips (top bar / input box / footer): bg + frame. */
  chrome: Paint
  chromeBorder: Paint
  /** Code-card background fill (frame stays `code`). */
  codeBg: Paint
}

/** Layered warm palette: coral brand, teal info, paneled chrome. */
const truecolorPalette: PaletteSpec = {
  primary: rgb(232, 131, 108), // #E8836C coral
  accent: rgb(91, 200, 213), // #5BC8D5 teal
  muted: rgb(139, 148, 158), // #8B949E
  subtle: rgb(110, 118, 129), // #6E7681
  strong: pair('\x1b[1m\x1b[38;2;230;237;243m', '\x1b[39m\x1b[22m'), // near-white bold
  ok: rgb(143, 206, 154), // #8FCE9A
  fail: rgb(224, 108, 117), // #E06C75
  warn: rgb(229, 192, 123), // #E5C07B
  live: rgb(198, 120, 221), // #C678DD
  selected: comb('\x1b[1m\x1b[38;2;230;237;243m\x1b[48;2;61;68;80m', '\x1b[49m\x1b[39m\x1b[22m'),
  border: rgb(86, 93, 102), // #565D66
  code: rgb(121, 184, 255), // #79B8FF
  quote: rgb(160, 168, 179), // #A0A8B3
  placeholder: pair('\x1b[2;3m\x1b[38;2;139;148;158m', '\x1b[39m\x1b[23m\x1b[22m'), // dim italic
  bubble: bg(59, 47, 43), // #3B2F2B warm dark
  bubbleBorder: rgb(168, 104, 82), // #A86852
  panel: bg(35, 39, 46), // #23272E
  panelBorder: rgb(70, 80, 92), // #46505C
  chrome: bg(32, 36, 43), // #20242B
  chromeBorder: rgb(58, 65, 76), // #3A414C
  codeBg: bg(23, 27, 33), // #171B21
}

/** xterm-256 approximations of the same semantics. */
const palette256: PaletteSpec = {
  primary: c256(209),
  accent: c256(80),
  muted: c256(245),
  subtle: c256(240),
  strong: pair('\x1b[1;38;5;255m', '\x1b[39m\x1b[22m'),
  ok: c256(114),
  fail: c256(203),
  warn: c256(215),
  live: c256(141),
  selected: comb('\x1b[1;38;5;255;48;5;238m', '\x1b[49m\x1b[39m\x1b[22m'),
  border: c256(242),
  code: c256(117),
  quote: c256(146),
  placeholder: pair('\x1b[2;3;38;5;245m', '\x1b[39m\x1b[23m\x1b[22m'),
  bubble: bg256(237),
  bubbleBorder: c256(173),
  panel: bg256(236),
  panelBorder: c256(244),
  chrome: bg256(235),
  chromeBorder: c256(242),
  codeBg: bg256(234),
}

/** Plain-text fallback: structure only, no SGR at all. */
const plainPalette: PaletteSpec = {
  primary: (t) => t,
  accent: (t) => t,
  muted: (t) => t,
  subtle: (t) => t,
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
  bubble: (t) => t,
  bubbleBorder: (t) => t,
  panel: (t) => t,
  panelBorder: (t) => t,
  chrome: (t) => t,
  chromeBorder: (t) => t,
  codeBg: (t) => t,
}

const palette = noColor ? plainPalette : truecolor ? truecolorPalette : palette256

export const theme = palette

export type Theme = typeof theme
