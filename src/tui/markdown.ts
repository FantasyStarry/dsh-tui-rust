/**
 * Markdown renderer — the pragmatic subset the transcript actually needs:
 * headings, bullet/ordered lists, blockquotes, horizontal rules, fenced
 * code blocks (highlighted), and inline styles (bold / italic / strike /
 * inline code). Pure text-in → styled-lines-out; cell-safe layout via the
 * span layer; unknown syntax falls through as plain text.
 */

import { highlightCodeLine, normalizeLang } from './highlight.js'
import { boxed, type BoxStyle } from './box.js'
import { renderSpans, wrapSpans, type Span } from './span.js'
import { theme } from './theme.js'

/** Inline syntax → styled spans. Unmatched text stays plain. */
export function inlineSpans(text: string): readonly Span[] {
  const spans: Span[] = []
  let plain = ''
  const flush = (): void => {
    if (plain !== '') {
      spans.push({ text: plain })
      plain = ''
    }
  }
  // Ordered: code first (its content must not be styled), then emphasis.
  const re = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(__([^_]+)__)|(\*([^*\s][^*]*)\*)|(~~([^~]+)~~)/gu
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    plain += text.slice(last, match.index)
    last = re.lastIndex
    if (match[2] !== undefined) {
      flush()
      spans.push({ text: match[2], paint: theme.code })
    } else if (match[4] !== undefined) {
      flush()
      spans.push({ text: match[4], paint: theme.strong })
    } else if (match[6] !== undefined) {
      flush()
      spans.push({ text: match[6], paint: theme.strong })
    } else if (match[8] !== undefined) {
      flush()
      spans.push({ text: match[8], paint: (t) => `\x1b[3m${t}\x1b[23m` })
    } else if (match[10] !== undefined) {
      flush()
      spans.push({ text: match[10], paint: theme.muted })
    }
  }
  plain += text.slice(last)
  flush()
  return spans
}

/**
 * Render markdown text to styled frame lines within `width` cells.
 * Fenced code blocks hard-clip (code does not reflow); prose word-wraps.
 */
export function renderMarkdown(text: string, width: number): string[] {
  const lines: string[] = []
  const source = text.split('\n')
  let inFence = false
  let fenceLang = ''
  let fenceLines: string[] = []

  const flushFence = (): void => {
    const label = fenceLang === '' ? 'code' : fenceLang
    const style: BoxStyle = { bg: theme.codeBg, border: theme.code, title: label, titlePaint: theme.code }
    lines.push(...boxed(fenceLines, width, style))
  }

  for (const raw of source) {
    const fenceMatch = /^\s*```(.*)$/.exec(raw)
    if (fenceMatch) {
      if (!inFence) {
        inFence = true
        fenceLang = normalizeLang(fenceMatch[1] ?? '')
        fenceLines = []
      } else {
        inFence = false
        flushFence()
      }
      continue
    }
    if (inFence) {
      const spans = highlightCodeLine(raw, fenceLang)
      fenceLines.push(renderSpans(spans, Math.max(4, width - 4)))
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(raw)
    if (heading) {
      const level = (heading[1] ?? '#').length
      const body = inlineSpans(heading[2] ?? '')
      const top = level <= 2
      const mark = top ? '■ ' : '▪ '
      const markPaint = top ? theme.primary : theme.accent
      const styled = top ? [{ text: mark, paint: markPaint }, ...body.map((span) => ({ ...span, paint: span.paint ?? theme.strong }))] : [{ text: mark, paint: markPaint }, ...body]
      for (const line of wrapSpans(styled, width)) {
        lines.push(line)
      }
      continue
    }

    const rule = /^\s*(---+|\*\*\*+)\s*$/.exec(raw)
    if (rule) {
      lines.push(theme.muted('┄'.repeat(16)))
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(raw)
    if (quote) {
      const body = inlineSpans(quote[1] ?? '')
      for (const line of wrapSpans([{ text: '▏ ', paint: theme.quote }, ...body], width)) {
        lines.push(line)
      }
      continue
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw)
    if (bullet) {
      const depth = Math.floor((bullet[1]?.length ?? 0) / 2)
      const indent = '  '.repeat(depth)
      const body = inlineSpans(bullet[2] ?? '')
      for (const line of wrapSpans([{ text: '• ', paint: theme.text }, ...body], width, indent)) {
        lines.push(line)
      }
      continue
    }

    const ordered = /^(\s*)\d+[.)]\s+(.*)$/.exec(raw)
    if (ordered) {
      const depth = Math.floor((ordered[1]?.length ?? 0) / 2)
      const indent = '  '.repeat(depth) + '  '
      const body = inlineSpans(ordered[2] ?? '')
      for (const line of wrapSpans(body, width, indent)) {
        lines.push(line)
      }
      continue
    }

    if (raw.trim() === '') {
      lines.push('')
      continue
    }

    for (const line of wrapSpans(inlineSpans(raw), width)) {
      lines.push(line)
    }
  }
  if (inFence) flushFence()
  return lines
}
