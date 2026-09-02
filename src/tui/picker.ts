/**
 * Model picker — pure state and rendering for the `/model` selector.
 *
 * Three stages walked in order: provider → model → reasoning effort (the
 * effort stage is skipped when the resolved route advertises none). The app
 * owns async loading between stages; this module only holds navigable state
 * and paints lines, so it stays unit-testable inside the smoke harness.
 */

import { theme } from './theme.js'
import { truncateWidth } from './width.js'

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
  const lines: string[] = [theme.border('╭─ ') + theme.accent(state.title)]
  const from = Math.max(0, state.index - 8)
  const visible = state.items.slice(from, from + 17)
  for (let i = 0; i < visible.length; i++) {
    const item = visible[i]
    if (!item) continue
    const actual = from + i
    const isSelected = actual === state.index
    const cursor = isSelected ? theme.primary('❯ ') : '  '
    const label = isSelected ? theme.strong(item.label) : item.label
    const hint = item.hint ? theme.muted(` — ${item.hint}`) : ''
    const body = `${cursor}${label}${hint}`
    lines.push(truncateWidth(body, Math.max(8, width - 2)))
  }
  lines.push(theme.border('╰─') + theme.muted(' ↑/↓ 选择 · Enter 确认 · Esc 取消'))
  return lines
}
