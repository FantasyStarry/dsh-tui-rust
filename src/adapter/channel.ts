/**
 * Channel — projects the persisted session event log into transcript rows.
 *
 * The session log is the source of truth (dsh-TUI architecture principle).
 * The channel keeps only a projection that suits the current TUI: streaming
 * chunks append to the open row of the same kind, tool results attach to
 * their tool row, and turn boundaries just mark state. Nothing here is
 * persisted; everything can be rebuilt from `session/event` replay.
 */

import type { SessionEvent } from '../kernel/types.js'

export type RowKind = 'user' | 'assistant' | 'thought' | 'tool' | 'system'

export interface TranscriptRow {
  readonly id: number
  kind: RowKind
  text: string
  /** Tool rows: pending → running → ok | failed. */
  status?: 'pending' | 'running' | 'ok' | 'failed'
  /** Tool rows: tool display name. */
  tool?: string
  /** Monotonic frame counter bump marker for the renderer. */
  seq: number
}

export type AgentRunState = 'idle' | 'thinking' | 'working'

let rowId = 0

function textOf(event: SessionEvent, ...keys: string[]): string {
  for (const key of keys) {
    const value = event[key]
    if (typeof value === 'string') return value
  }
  return ''
}

/**
 * Defensive event ingest. Unknown event types are ignored (the kernel is a
 * developer preview; new types appear without notice). Chunk semantics:
 * assistant/thought deltas append to the currently open row of that kind —
 * this is the real streaming that the ACP wire protocol never carried.
 */
export class Channel {
  readonly rows: TranscriptRow[] = []
  runState: AgentRunState = 'idle'
  /** Bumped on every projection change; render loops compare against it. */
  version = 0

  private openAssistantId: number | null = null
  private openThoughtId: number | null = null

  ingest(event: SessionEvent): void {
    switch (event.type) {
      case 'turn/start': {
        this.runState = 'thinking'
        break
      }
      case 'turn/end': {
        this.runState = 'idle'
        this.openAssistantId = null
        this.openThoughtId = null
        break
      }
      case 'assistant/chunk': {
        this.appendChunk('assistant', 'assistant', textOf(event, 'text', 'delta'))
        break
      }
      case 'tool/call': {
        const tool = textOf(event, 'tool', 'name', 'title') || 'tool'
        this.openAssistantId = null
        this.openThoughtId = null
        this.rows.push({
          id: ++rowId,
          kind: 'tool',
          tool,
          text: textOf(event, 'summary', 'input', 'description'),
          status: 'running',
          seq: ++this.version,
        })
        this.runState = 'working'
        break
      }
      case 'tool/result': {
        const last = this.lastToolRow()
        if (last) {
          last.status = event.isError === true ? 'failed' : 'ok'
          const out = textOf(event, 'output', 'text')
          if (out) last.text = out
        }
        this.runState = 'thinking'
        break
      }
      default: {
        // Reasoning/thought chunk naming is not yet pinned across kernel
        // versions; accept the common shapes but never guess a type that
        // carries no text.
        if (/(thought|reasoning)/i.test(event.type)) {
          const text = textOf(event, 'text', 'delta')
          if (text) this.appendChunk('thought', 'thought', text)
        }
        break
      }
    }
  }

  /** A user prompt submitted from the editor. */
  pushUser(text: string): void {
    this.openAssistantId = null
    this.openThoughtId = null
    this.rows.push({ id: ++rowId, kind: 'user', text, seq: ++this.version })
  }

  /** Local notice (connection loss, resume hint, …) — never model-visible. */
  pushSystem(text: string): void {
    this.rows.push({ id: ++rowId, kind: 'system', text, seq: ++this.version })
  }

  private appendChunk(kind: Extract<RowKind, 'assistant' | 'thought'>, openKind: 'assistant' | 'thought', text: string): void {
    if (!text) return
    const openId = openKind === 'assistant' ? this.openAssistantId : this.openThoughtId
    const open = openId === null ? undefined : this.rows.find((row) => row.id === openId)
    if (open && open.kind === kind) {
      open.text += text
    } else {
      const row: TranscriptRow = { id: ++rowId, kind, text, seq: ++this.version }
      this.rows.push(row)
      if (openKind === 'assistant') this.openAssistantId = row.id
      else this.openThoughtId = row.id
    }
    this.version++
  }

  private lastToolRow(): TranscriptRow | undefined {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const row = this.rows[i]
      if (row && row.kind === 'tool') return row
    }
    return undefined
  }
}
