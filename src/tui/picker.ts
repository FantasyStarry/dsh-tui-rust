/**
 * Model picker — pure state and rendering for the `/model` selector.
 *
 * Three stages walked in order: provider → model → reasoning effort (the
 * effort stage is skipped when the resolved route advertises none). The app
 * owns async loading between stages; this module only holds navigable state
 * and paints lines, so it stays unit-testable inside the smoke harness.
 *
 * Rendered as a chrome panel with a titled frame; the selected row gets a
 * full-width background highlight (the `selected` token as the line fill).
 */

import { theme } from './theme.js'
import { boxLine, boxTop, boxBottom, type BoxStyle } from './box.js'

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

/** Render the picker as a boxed overlay block (already themed). */
export function renderPicker(state: PickerState, width: number): string[] {
  const style: BoxStyle = { bg: theme.chrome, border: theme.chromeBorder, title: state.title, titlePaint: theme.strong }
  const from = Math.max(0, state.index - 8)
  const visible = state.items.slice(from, from + 17)
  const content: string[] = []
  for (let i = 0; i < visible.length; i++) {
    const item = visible[i]
    if (!item) continue
    const actual = from + i
    const isSelected = actual === state.index
    const cursor = isSelected ? theme.primary('❯ ') : '  '
    const label = isSelected ? theme.strong(item.label) : item.label
    const hint = item.hint ? theme.subtle(` — ${item.hint}`) : ''
    content.push(boxLine(`${cursor}${label}${hint}`, width, style, isSelected ? theme.selected : undefined))
  }
  const hint = theme.subtle('↑/↓ 选择 · Enter 确认 · Esc 取消')
  return [boxTop(width, style), ...content, boxBottom(width, style, hint)]
}
