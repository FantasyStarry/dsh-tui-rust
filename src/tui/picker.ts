/**
 * Model picker — pure state and rendering for the `/model` selector.
 *
 * Three stages walked in order: provider → model → reasoning effort (the
 * effort stage is skipped when the resolved route advertises none). The app
 * owns async loading between stages; this module only holds navigable state
 * and paints lines, so it stays unit-testable inside the smoke harness.
 */

import { theme } from './theme.js'

export interface PickerItem {
  /** Value carried out on selection (id / effort id). */
  readonly value: string
  /** Primary display label. */
  readonly label: string
  /** Optional secondary hint rendered dim beside the label. */
  readonly hint?: string
  /** Non-selectable row (e.g. the loading placeholder) — confirm() skips it. */
  readonly disabled?: boolean
}

export interface PickerState {
  readonly title: string
  readonly items: readonly PickerItem[]
  index: number
}

export function openPicker(title: string, items: readonly PickerItem[]): PickerState {
  return { title, items, index: 0 }
}

/** Move the cursor by ±delta, clamped to the item range. */
export function movePicker(state: PickerState, delta: number): void {
  if (state.items.length === 0) return
  const next = state.index + delta
  state.index = Math.max(0, Math.min(state.items.length - 1, next))
}

/** The item under the cursor, or undefined for an empty list. */
export function pickedItem(state: PickerState): PickerItem | undefined {
  return state.items[state.index]
}

/** Render the picker as an overlay block (already themed). */
export function renderPicker(state: PickerState, width: number): string[] {
  const lines: string[] = [theme.accent(`┌ ${state.title}`)]
  const from = Math.max(0, state.index - 8)
  const visible = state.items.slice(from, from + 17)
  for (let i = 0; i < visible.length; i++) {
    const item = visible[i]
    if (!item) continue
    const actual = from + i
    const cursor = actual === state.index ? '❯ ' : '  '
    const hint = item.hint ? theme.muted(` — ${item.hint}`) : ''
    const body = `${cursor}${item.label}${hint}`
    lines.push(truncate(actual === state.index ? theme.selected(body) : body, width - 2))
  }
  lines.push(theme.muted('└ ↑/↓ 选择 · Enter 确认 · Esc 取消'))
  return lines
}

function truncate(line: string, width: number): string {
  let used = 0
  let out = ''
  for (const ch of line) {
    if (ch === '\x1b') {
      out += ch
      continue
    }
    const w = ch.codePointAt(0)! > 0x1100 && /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60]/u.test(ch) ? 2 : 1
    if (used + w > width) break
    out += ch
    used += w
  }
  return out
}
