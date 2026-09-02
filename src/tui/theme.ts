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
  /** Brand / primary accent — warm saffron, used for structure and activity. */
  primary: wrap('\x1b[38;5;221m', '\x1b[39m'),
  /** Secondary accent — calm teal for headings, bullets and routes. */
  accent: wrap('\x1b[38;5;80m', '\x1b[39m'),
  /** De-emphasized content — hints, sealed thoughts, secondary lines. */
  muted: wrap('\x1b[38;5;244m', '\x1b[39m'),
  /** User-authored content — prompts and important labels. */
  strong: wrap('\x1b[1;38;5;255m', '\x1b[0m'),
  /** Success / settled tool rows. */
  ok: wrap('\x1b[38;5;114m', '\x1b[39m'),
  /** Failure / failed tool rows and errors. */
  fail: wrap('\x1b[38;5;203m', '\x1b[39m'),
  /** Warnings and attention. */
  warn: wrap('\x1b[38;5;215m', '\x1b[39m'),
  /** Streaming activity markers. */
  live: wrap('\x1b[38;5;141m', '\x1b[39m'),
  /** Reverse video for the picker cursor row. */
  selected: wrap('\x1b[1;38;5;255;48;5;238m', '\x1b[0m'),
  /** Structural line used for cards and the editor frame. */
  border: wrap('\x1b[38;5;221m', '\x1b[39m'),
  /** Small visual cue for code and quoted material. */
  code: wrap('\x1b[38;5;117m', '\x1b[39m'),
  quote: wrap('\x1b[38;5;146m', '\x1b[39m'),
} satisfies Record<string, Paint>

export type Theme = typeof theme
