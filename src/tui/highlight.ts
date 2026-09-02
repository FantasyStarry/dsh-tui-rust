/**
 * Minimal token highlighter for fenced code blocks. Deliberately shallow:
 * strings, comments, numbers, and a keyword set per language — enough to
 * give code visual structure without a parser. Everything degrades to plain
 * text for unknown languages. Pure functions; cell-safe layout happens in
 * the markdown layer.
 */

import { theme } from './theme.js'
import type { Span } from './span.js'

const KEYWORDS: Record<string, ReadonlySet<string>> = {
  js: new Set(['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'extends', 'import', 'export', 'from', 'await', 'async', 'new', 'this', 'try', 'catch', 'finally', 'throw', 'switch', 'case', 'break', 'continue', 'default', 'true', 'false', 'null', 'undefined']),
  ts: new Set(['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'extends', 'implements', 'interface', 'type', 'import', 'export', 'from', 'await', 'async', 'new', 'this', 'try', 'catch', 'finally', 'throw', 'switch', 'case', 'break', 'continue', 'default', 'readonly', 'public', 'private', 'protected', 'static', 'enum', 'namespace', 'declare', 'as', 'satisfies', 'keyof', 'typeof', 'instanceof', 'in', 'of', 'true', 'false', 'null', 'undefined', 'never', 'unknown', 'any', 'string', 'number', 'boolean', 'void']),
  json: new Set(['true', 'false', 'null']),
  py: new Set(['def', 'return', 'if', 'elif', 'else', 'for', 'while', 'class', 'import', 'from', 'as', 'with', 'try', 'except', 'finally', 'raise', 'lambda', 'yield', 'pass', 'break', 'continue', 'and', 'or', 'not', 'in', 'is', 'True', 'False', 'None', 'self']),
  bash: new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'return', 'export', 'local', 'echo', 'cd', 'set', 'source', 'exit']),
  yaml: new Set(['true', 'false', 'null']),
}

const ALIASES: Record<string, string> = {
  javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
  typescript: 'ts', tsx: 'ts', mts: 'ts',
  python: 'py', py3: 'py',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  yml: 'yaml',
}

export function normalizeLang(lang: string): string {
  const key = lang.trim().toLowerCase()
  return ALIASES[key] ?? key
}

/** Tokenize one code line into styled spans (empty lines → single empty span). */
export function highlightCodeLine(line: string, lang: string): readonly Span[] {
  const key = normalizeLang(lang)
  const keywords = KEYWORDS[key]
  if (!keywords || line.trim() === '') return [{ text: line }]

  const spans: Span[] = []
  const push = (text: string, paint?: Span['paint']): void => {
    if (text !== '') spans.push(paint ? { text, paint } : { text })
  }
  // Comment / string scanners first; the remainder splits on words.
  const hashComment = key === 'py' || key === 'bash' || key === 'yaml'
  let rest = line
  // Leading indentation stays plain.
  const indent = /^\s*/.exec(rest)?.[0] ?? ''
  push(indent)
  rest = rest.slice(indent.length)

  while (rest !== '') {
    const comment =
      rest.startsWith('//') && !hashComment
        ? rest
        : rest.startsWith('#') && hashComment
          ? rest
          : undefined
    if (comment !== undefined) {
      push(comment, theme.muted)
      break
    }
    const quote = /^("([^"\\]|\\.)*"?|'([^'\\]|\\.)*'?|`[^`]*`?)/.exec(rest)?.[0]
    if (quote !== undefined) {
      push(quote, theme.warn)
      rest = rest.slice(quote.length)
      continue
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest)?.[0]
    if (word !== undefined) {
      push(word, keywords.has(word) ? theme.strong : undefined)
      rest = rest.slice(word.length)
      continue
    }
    const number = /^\d[\d._]*/.exec(rest)?.[0]
    if (number !== undefined) {
      push(number, theme.live)
      rest = rest.slice(number.length)
      continue
    }
    // Punctuation and whitespace: consume one char (whitespace runs stay plain).
    const ws = /^\s+/.exec(rest)?.[0]
    if (ws !== undefined) {
      push(ws)
      rest = rest.slice(ws.length)
      continue
    }
    push(rest[0] ?? '')
    rest = rest.slice(1)
  }
  return spans
}
