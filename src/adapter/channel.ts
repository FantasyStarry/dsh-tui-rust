/**
 * Channel — projects the persisted session event log into transcript rows.
 *
 * The session log is the source of truth (dsh-TUI architecture principle).
 * The channel keeps only a projection that suits the current TUI: streaming
 * chunks append to the open row of the same kind, tool results attach to
 * their tool row, and turn boundaries just mark state. Nothing here is
 * persisted; everything can be rebuilt from `session/event` replay.
 *
 * Event shapes mirror dsh v0.1.1-rc.2 (see src/kernel/types.ts): the payload
 * lives under `event.data` — `assistant/chunk` carries a `StreamChunk` whose
 * `text-delta` / `reasoning-delta` variants are the real streaming deltas
 * the old ACP wire protocol never had. Parsing stays defensive: unknown
 * event types are ignored, legacy flat payloads still parse.
 */

import type { SessionEvent, StreamChunk } from '../kernel/types.js'

export type RowKind = 'user' | 'assistant' | 'thought' | 'tool' | 'system'

export interface TranscriptRow {
  readonly id: number
  kind: RowKind
  text: string
  /** Tool rows: pending → running → ok | failed. */
  status?: 'pending' | 'running' | 'ok' | 'failed'
  /** Tool rows: tool display name. */
  tool?: string
  /** Thought rows: wall-clock start while streaming (drives the live timer). */
  startMs?: number
  /** Thought rows: sealed duration in seconds (collapses the block). */
  seconds?: number
  /** Monotonic frame counter bump marker for the renderer. */
  seq: number
}

export type AgentRunState = 'idle' | 'thinking' | 'working'

/** The request route the log last recorded (`request/header` — the truth). */
export interface SessionRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface SessionUsage {
  input: number
  output: number
  reasoning: number
  messages: number
}

let rowId = 0

/** Max characters of raw tool arguments kept as the tool-row preview. */
const ARGS_PREVIEW_MAX = 160

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * The event payload. The real kernel nests fields under `event.data`; fall
 * back to the event itself for legacy flat envelopes (older previews and
 * local fake kernels).
 */
function dataOf(event: SessionEvent): Record<string, unknown> {
  return recordOf(event.data) ?? event
}

function str(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return ''
}

function isStreamChunk(value: unknown): value is StreamChunk {
  const record = recordOf(value)
  if (!record) return false
  const type = record['type']
  return (
    type === 'block-start' ||
    type === 'text-delta' ||
    type === 'reasoning-delta' ||
    type === 'tool-call-delta' ||
    type === 'block-end' ||
    type === 'usage' ||
    type === 'finish'
  )
}

/** Join the text of all `text` blocks in a content array. */
function blockText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    const block = recordOf(item)
    if (block && block['type'] === 'text' && typeof block['text'] === 'string') {
      parts.push(block['text'])
    }
  }
  return parts.join('')
}

/** Pull the model-facing text out of a `tool/result` event's message. */
function toolResultText(data: Record<string, unknown>): string {
  const message = recordOf(data['message'])
  if (!message) return ''
  const content = Array.isArray(message['content']) ? message['content'] : []
  const first = recordOf(content[0])
  if (first && first['type'] === 'tool-result') return blockText(first['content'])
  return ''
}

function preview(text: string, max = ARGS_PREVIEW_MAX): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max) + '…' : clean
}

function numOf(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Defensive event ingest. Unknown event types are ignored (the kernel is a
 * developer preview; new types appear without notice). Chunk semantics:
 * `text-delta` appends to the open assistant row, `reasoning-delta` to the
 * open thought row — real deltas, appended while the row is open.
 */
export class Channel {
  readonly rows: TranscriptRow[] = []
  runState: AgentRunState = 'idle'
  /** Bumped on every projection change; render loops compare against it. */
  version = 0
  /** Latest route recorded by `request/header` — session truth, not UI state. */
  route: SessionRoute | null = null
  /** Cumulative token usage accumulated from `assistant/message` events. */
  usage: SessionUsage = { input: 0, output: 0, reasoning: 0, messages: 0 }

  private openAssistantId: number | null = null
  private openThoughtId: number | null = null

  ingest(event: SessionEvent): void {
    switch (event.type) {
      case 'turn/start': {
        this.runState = 'thinking'
        break
      }
      case 'request/header': {
        const data = dataOf(event)
        const header = recordOf(data['header'])
        const config = header ? recordOf(header['config']) : undefined
        if (config) {
          const provider = str(config, 'provider')
          const model = str(config, 'model')
          if (provider && model) {
            const reasoningEffort = str(config, 'reasoningEffort')
            this.route = reasoningEffort ? { provider, model, reasoningEffort } : { provider, model }
            this.version++
          }
        }
        break
      }
      case 'assistant/message': {
        const data = dataOf(event)
        const usage = recordOf(data['usage'])
        if (usage) {
          this.usage = {
            input: this.usage.input + numOf(usage, 'inputTokens'),
            output: this.usage.output + numOf(usage, 'outputTokens'),
            reasoning: this.usage.reasoning + numOf(usage, 'reasoningTokens'),
            messages: this.usage.messages + 1,
          }
          this.version++
        }
        break
      }
      case 'turn/end': {
        this.runState = 'idle'
        this.sealThought()
        this.openAssistantId = null
        const data = dataOf(event)
        const reason = recordOf(data['reason'])
        if (reason && str(reason, 'kind') === 'error') {
          const failure = recordOf(reason['error'])
          this.pushSystem(`turn 失败：${(failure && str(failure, 'message')) || '未知错误'}`)
        }
        break
      }
      case 'user/message': {
        // The user row is projected from the log, not echoed optimistically —
        // the session log stays the single source of truth. Plugin-injected
        // context (file notices, skill content) shares this event type with a
        // different `source.kind`; only genuine user prompts become rows.
        const data = dataOf(event)
        const source = recordOf(data['source'])
        if (source && str(source, 'kind') !== 'user') break
        const text = blockText(data['content']) || str(data, 'text')
        if (text) this.pushUser(text)
        break
      }
      case 'assistant/chunk': {
        const data = dataOf(event)
        const chunk = data['chunk']
        if (isStreamChunk(chunk)) {
          if (chunk.type === 'text-delta' && chunk.text) {
            this.appendChunk('assistant', 'assistant', chunk.text)
          } else if (chunk.type === 'reasoning-delta' && chunk.text) {
            this.appendChunk('thought', 'thought', chunk.text)
          }
          // block-start / block-end / usage / finish / tool-call-delta carry
          // no transcript text here; tool activity projects from tool/call
          // and tool/result events.
          break
        }
        // Legacy flat shape: a bare text field on the event payload.
        const text = str(data, 'text', 'delta')
        if (text) this.appendChunk('assistant', 'assistant', text)
        break
      }
      case 'tool/call': {
        const data = dataOf(event)
        const tool = str(data, 'name', 'tool') || 'tool'
        this.sealThought()
        this.openAssistantId = null
        this.rows.push({
          id: ++rowId,
          kind: 'tool',
          tool,
          text: preview(str(data, 'arguments', 'summary', 'input')),
          status: 'running',
          seq: ++this.version,
        })
        this.runState = 'working'
        break
      }
      case 'tool/result': {
        const data = dataOf(event)
        const last = this.lastToolRow()
        if (last) {
          const message = recordOf(data['message'])
          const content = message && Array.isArray(message['content']) ? message['content'] : []
          const firstBlock = recordOf(content[0])
          const failed =
            data['error'] !== undefined ||
            data['isError'] === true ||
            (firstBlock && firstBlock['isError'] === true)
          last.status = failed ? 'failed' : 'ok'
          const out = toolResultText(data) || str(data, 'output', 'text')
          if (out) last.text = preview(out)
        }
        this.runState = 'thinking'
        break
      }
      default: {
        // Reasoning/thought chunk naming is not pinned across kernel versions;
        // accept common side-channel shapes but never guess a type that
        // carries no text.
        if (/(thought|reasoning)/i.test(event.type)) {
          const data = dataOf(event)
          const chunk = data['chunk']
          const text = isStreamChunk(chunk) && chunk.type === 'reasoning-delta' ? chunk.text : str(data, 'text', 'delta')
          if (text) this.appendChunk('thought', 'thought', text)
        }
        break
      }
    }
  }

  /** A user prompt submitted from the editor (used by tests and the fake kernel). */
  pushUser(text: string): void {
    this.sealThought()
    this.openAssistantId = null
    this.rows.push({ id: ++rowId, kind: 'user', text, seq: ++this.version })
  }

  /** Local notice (connection loss, resume hint, …) — never model-visible. */
  pushSystem(text: string): void {
    this.rows.push({ id: ++rowId, kind: 'system', text, seq: ++this.version })
  }

  /** Stamp the sealed duration onto the open thought row and close it. */
  private sealThought(): void {
    if (this.openThoughtId === null) return
    const row = this.rows.find((candidate) => candidate.id === this.openThoughtId)
    if (row && row.seconds === undefined && row.startMs !== undefined) {
      row.seconds = Math.round((Date.now() - row.startMs) / 100) / 10
    }
    this.openThoughtId = null
  }

  private appendChunk(kind: Extract<RowKind, 'assistant' | 'thought'>, openKind: 'assistant' | 'thought', text: string): void {
    if (!text) return
    const openId = openKind === 'assistant' ? this.openAssistantId : this.openThoughtId
    const open = openId === null ? undefined : this.rows.find((row) => row.id === openId)
    if (open && open.kind === kind) {
      open.text += text
    } else {
      const row: TranscriptRow =
        openKind === 'thought'
          ? { id: ++rowId, kind, text, startMs: Date.now(), seq: ++this.version }
          : { id: ++rowId, kind, text, seq: ++this.version }
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
