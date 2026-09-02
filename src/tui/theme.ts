/**
 * Theme tokens — the semantic color layer between the channel/view and raw
 * SGR (pi's token-set idea, shrunk to what the skeleton uses). Views never
 * write escape codes directly; they pick a token by MEANING. `NO_COLOR`
 * (or a broken terminal) degrades to plain text.
 */

type Paint = (text: string) => string

const noColor = process.env['NO_COLOR'] !== undefined

function wrap(open: string, close: string): Paint {
  if (noColor) return (text) => text
  return (text) => `${open}${text}${close}`
}

export const theme = {
  /** Primary accent — header, active markers. */
  accent: wrap('\x1b[36m', '\x1b[39m'),
  /** De-emphasized content — hints, sealed thoughts, secondary lines. */
  muted: wrap('\x1b[2m', '\x1b[22m'),
  /** User-authored content — prompts, the editor line. */
  strong: wrap('\x1b[1m', '\x1b[22m'),
  /** Success / settled tool rows. */
  ok: wrap('\x1b[32m', '\x1b[39m'),
  /** Failure / failed tool rows and errors. */
  fail: wrap('\x1b[31m', '\x1b[39m'),
  /** Warnings and attention. */
  warn: wrap('\x1b[33m', '\x1b[39m'),
  /** Streaming activity markers. */
  live: wrap('\x1b[35m', '\x1b[39m'),
  /** Reverse video for the picker cursor row. */
  selected: wrap('\x1b[7m', '\x1b[27m'),
} satisfies Record<string, Paint>

export type Theme = typeof theme
