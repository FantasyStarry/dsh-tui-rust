/**
 * Model picker — pure state and rendering for the `/model` selector.
 *
 * Three stages walked in order: provider → model → reasoning effort (the
 * effort stage is skipped when the resolved route advertises none). The app
 * owns async loading between stages; this module only holds navigable state
 * and paints lines, so it stays unit-testable inside the smoke harness.
 *
 * Layout follows the kimi-code dialog spec (`.agents/skills/write-tui/
 * DESIGN.md`): flat `─` borders (primary) top and bottom only, title
 * (primary + bold), hint (textMuted) hugging the title, listed rows with the
 * `❯ ` pointer on the selected row, a ` ← current` success marker appended
 * to the row that holds the live route value, and a `▼ N more` scroll
 * indicator for long lists.
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
  /** The live route value at this stage — its row gets ` ← current`. */
  readonly current?: string
}

export function openPicker(title: string, items: readonly PickerItem[], current?: string): PickerState {
  const base = { title, items, index: 0 }
  return current === undefined ? base : { ...base, current }
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

/** kimi SELECT_POINTER / CURRENT_MARK, per DESIGN.md: indents align. */
const POINTER_W = 2
const HINT = '↑/↓ 选择 · Enter 确认 · Esc 取消'

/** Render the picker as a flat-bordered overlay block (already themed). */
export function renderPicker(state: PickerState, width: number): string[] {
  const lines: string[] = []
  lines.push(theme.primary('─'.repeat(width)))
  lines.push(' ' + theme.title(state.title))
  lines.push(theme.subtle(' ' + HINT))
  lines.push('')

  const from = Math.max(0, state.index - 8)
  const visible = state.items.slice(from, from + 17)
  for (let i = 0; i < visible.length; i++) {
    const item = visible[i]
    if (!item) continue
    const actual = from + i
    const selected = actual === state.index
    const pointer = selected ? theme.title('❯ ') : ' '.repeat(POINTER_W)
    const label = selected ? theme.title(item.label) : item.label
    const current = state.current !== undefined && item.value === state.current ? theme.ok('  ← current') : ''
    const hint = item.hint ? theme.subtle('  ' + item.hint) : ''
    lines.push(truncateWidth(`  ${pointer}${label}${hint}${current}`, Math.max(8, width - 4)))
  }
  const remaining = state.items.length - (from + visible.length)
  if (remaining > 0) {
    lines.push(theme.subtle(` ▼ ${remaining} more`))
  }
  lines.push(theme.primary('─'.repeat(width)))
  return lines
}