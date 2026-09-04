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
  /** Tool rows: thought-style live timer. */
  startMs?: number
  /** Thought rows: sealed duration in seconds (collapses the block). */
  seconds?: number
  /** Tool rows: result diff card (dsh-tool-fs write/edit meta). */
  diff?: ToolDiffView
  /**
   * Pre-rendered lines (welcome card, route lines) pushed verbatim — the row
   * paints them as-is instead of styling `text`.
   */
  rawLines?: readonly string[]
  /**
   * Pinned rows hold the seal back: they stay in the live region (visible
   * chrome like the welcome card) until an explicit seal-all — the first
   * `turn/start` — flushes them together with the content that follows.
   */
  pinned?: boolean
  /** Monotonic frame counter bump marker for the renderer. */
  seq: number
}

export type AgentRunState = 'idle' | 'thinking' | 'working'

/** One rendered line of a tool-result diff card. */
export interface DiffLineView {
  readonly kind: 'add' | 'del' | 'ctx'
  readonly text: string
}

/** The diff card attached to a tool row (from `tool/result.meta.diffs`). */
export interface ToolDiffView {
  readonly path: string
  readonly added: number
  readonly removed: number
  readonly lines: readonly DiffLineView[]
}

/** Hard cap on diff lines kept per tool row (excess collapses into a note). */
const MAX_DIFF_LINES = 14

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

/** Count durable image references in a content array (defensive). */
function countImageBlocks(content: unknown): number {
  if (!Array.isArray(content)) return 0
  let count = 0
  for (const item of content) {
    const block = recordOf(item)
    if (block && block['type'] === 'image') count++
  }
  return count
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
  // ASCII ellipsis: the preview lands inside boxed tool cards whose padding
  // must agree with every terminal's width table (U+2026 is ambiguous).
  return clean.length > max ? clean.slice(0, max) + '...' : clean
}

function numOf(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** One hunk's line diff: context / removed / added, via prefix-suffix trim. */
function hunkDiffLines(oldText: string | null, newText: string): DiffLineView[] {
  const dropTrailingEmpty = (lines: string[]): string[] => {
    const copy = [...lines]
    if (copy.length > 0 && copy[copy.length - 1] === '') copy.pop()
    return copy
  }
  const oldLines = oldText === null ? [] : dropTrailingEmpty(oldText.split('\n'))
  const newLines = dropTrailingEmpty(newText.split('\n'))

  if (oldText === null) {
    return newLines.map((text) => ({ kind: 'add', text }))
  }
  let prefix = 0
  const min = Math.min(oldLines.length, newLines.length)
  while (prefix < min && oldLines[prefix] === newLines[prefix]) prefix++
  let suffix = 0
  while (
    suffix < min - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++
  }
  const lines: DiffLineView[] = []
  for (let i = 0; i < prefix; i++) lines.push({ kind: 'ctx', text: oldLines[i] ?? '' })
  for (let i = prefix; i < oldLines.length - suffix; i++) lines.push({ kind: 'del', text: oldLines[i] ?? '' })
  for (let i = prefix; i < newLines.length - suffix; i++) lines.push({ kind: 'add', text: newLines[i] ?? '' })
  for (let i = 0; i < suffix; i++) lines.push({ kind: 'ctx', text: oldLines[oldLines.length - suffix + i] ?? '' })
  return lines
}

/**
 * Narrow the dsh-tool-fs write/edit result meta (`{ diffs: FileDiff[] }`,
 * one FileDiff per applied hunk with 3 lines of context) into a renderable
 * diff card. Malformed meta returns undefined — replay must never throw.
 */
function diffViewFromMeta(meta: unknown): ToolDiffView | undefined {
  const record = recordOf(meta)
  const diffs = record?.['diffs']
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined

  const lines: DiffLineView[] = []
  let added = 0
  let removed = 0
  let path = ''
  let truncated = 0
  for (const entry of diffs) {
    const hunk = recordOf(entry)
    if (!hunk) continue
    const hunkPath = hunk['path']
    if (path === '' && typeof hunkPath === 'string') path = hunkPath
    const oldText = typeof hunk['oldText'] === 'string' ? hunk['oldText'] : null
    const newText = typeof hunk['newText'] === 'string' ? hunk['newText'] : null
    if (newText === null) continue
    for (const line of hunkDiffLines(oldText, newText)) {
      if (lines.length >= MAX_DIFF_LINES) {
        truncated++
        continue
      }
      lines.push(line)
      if (line.kind === 'add') added++
      else if (line.kind === 'del') removed++
    }
  }
  if (path === '' || (added === 0 && removed === 0)) return undefined
  const view = truncated > 0 ? [...lines, { kind: 'ctx' as const, text: `... 还有 ${truncated} 行变更` }] : lines
  return { path, added, removed, lines: view }
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
  /**
   * Rows [0, sealedRowCount) are FINAL: their text will never change again,
   * so the view flushes them into terminal scrollback continuously — the
   * Claude-Code-style gradual sedimentation. `advanceSeal` raises the cursor
   * to the leading run of final rows after every mutation; `turn/start` (and
   * compaction boundaries) seal ALL rows explicitly, which also releases the
   * pinned welcome/route rows together with the first turn's content.
   */
  sealedRowCount = 0
  /** Latest route recorded by `request/header` — session truth, not UI state. */
  route: SessionRoute | null = null
  /** Cumulative token usage accumulated from `assistant/message` events. */
  usage: SessionUsage = { input: 0, output: 0, reasoning: 0, messages: 0 }
  /** Latest folded `session/title` text — session truth for footer/browser. */
  title: string | null = null
  /** True while a `compaction/start` … `compaction/end` cycle is open. */
  compacting = false
  /** Last observed event seq (for rewind boundaries). Null before any event. */
  lastSeq: number | null = null
  /** Seqs of observed `turn/start` events (for rewind boundaries). */
  turnSeqs: number[] = []

  private openAssistantId: number | null = null
  private openThoughtId: number | null = null

  ingest(event: SessionEvent): void {
    if (typeof event.seq === 'number' && Number.isFinite(event.seq)) {
      this.lastSeq = event.seq
    }
    switch (event.type) {
      case 'turn/start': {
        if (typeof event.seq === 'number' && Number.isFinite(event.seq)) {
          this.turnSeqs.push(event.seq)
          if (this.turnSeqs.length > 50) this.turnSeqs.splice(0, this.turnSeqs.length - 50)
        }
        // The previous turns' rows are final — seal them into scrollback.
        if (this.sealedRowCount < this.rows.length) {
          this.sealedRowCount = this.rows.length
          this.version++
        }
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
        // The message is complete: close the open assistant row so it
        // sediments into scrollback immediately instead of staying live
        // until the next tool call or turn boundary.
        this.openAssistantId = null
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
        const images = countImageBlocks(data['content'])
        const label = text || (images > 0 ? '' : '…')
        const suffix = images > 0 ? (text ? ` [图片×${images}]` : `[图片×${images}]`) : ''
        if (label || suffix) this.pushUser(label + suffix)
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
          const diff = diffViewFromMeta(data['meta'])
          if (diff) {
            last.diff = diff
            last.text = ''
          } else {
            const out = toolResultText(data) || str(data, 'output', 'text')
            if (out) last.text = preview(out)
          }
        }
        this.runState = 'thinking'
        break
      }
      case 'session/title': {
        const data = dataOf(event)
        const title = str(data, 'title')
        if (title) {
          this.title = title
          this.version++
        }
        break
      }
      case 'command/run': {
        const data = dataOf(event)
        const name = str(data, 'name')
        const args = str(data, 'args')
        if (name) this.pushSystem(`› /${name}${args ? ` ${args.trim()}` : ''}`)
        break
      }
      case 'command/done': {
        const data = dataOf(event)
        const kind = str(data, 'kind')
        const text = str(data, 'text')
        if (kind === 'error') {
          this.pushSystem(`命令失败：${text || '未知错误'}`)
        } else if (text) {
          this.pushSystem(preview(text, 240))
        }
        break
      }
      case 'compaction/start': {
        this.compacting = true
        this.version++
        this.pushSystem('正在压缩上下文…')
        break
      }
      case 'compaction/summary': {
        const data = dataOf(event)
        const count = numOf(data, 'shadowedTokenCount')
        const summary = blockText(data['summary'])
        const note = count > 0 ? `（释放约 ${count} tokens）` : ''
        // The shadowed range leaves the surface; seal everything rendered so
        // far so the summary becomes the new visible boundary. The full log
        // stays replayable — this only moves the scrollback cursor.
        if (this.sealedRowCount < this.rows.length) {
          this.sealedRowCount = this.rows.length
        }
        this.pushSystem(`压缩完成${note}${summary ? `：${preview(summary, 200)}` : ''}`)
        break
      }
      case 'compaction/end': {
        this.compacting = false
        const data = dataOf(event)
        const error = str(data, 'error')
        if (error) this.pushSystem(`压缩失败：${error}`)
        this.version++
        break
      }
      case 'compaction/prune': {
        if (this.sealedRowCount < this.rows.length) {
          this.sealedRowCount = this.rows.length
        }
        this.pushSystem('已裁剪过期上下文')
        break
      }
      case 'hook/invoked': {
        const data = dataOf(event)
        const point = str(data, 'point') || 'hook'
        const matcher = str(data, 'matcher')
        this.pushSystem(`hook 运行中：${point}${matcher ? `（${matcher}）` : ''}`)
        break
      }
      case 'hook/result': {
        const data = dataOf(event)
        const decision = str(data, 'decision')
        const stderr = str(data, 'stderrSummary')
        if (decision && decision !== 'pass') {
          this.pushSystem(`hook 结果：${decision}${stderr ? ` — ${preview(stderr, 160)}` : ''}`)
        } else {
          this.version++
        }
        break
      }
      case 'approval/asked': {
        const data = dataOf(event)
        const tool = str(data, 'toolName') || 'tool'
        const reason = str(data, 'reason')
        this.pushSystem(`请求审批：${tool}${reason ? ` — ${preview(reason, 160)}` : ''}`)
        break
      }
      case 'approval/decided': {
        const data = dataOf(event)
        const outcome = str(data, 'outcome')
        const label =
          outcome === 'allowed-once' ? '已放行（单次）' : outcome === 'rejected' ? '已拒绝' : outcome === 'cancelled' ? '已撤回' : '无应答者（已 fail-closed）'
        this.pushSystem(`审批结果：${label}`)
        break
      }
      case 'todo/write': {
        const data = dataOf(event)
        const todos = Array.isArray(data['todos']) ? data['todos'] : []
        if (todos.length > 0) {
          const lines = todos
            .map((item) => {
              const record = recordOf(item)
              if (!record) return null
              const content = str(record, 'content')
              const status = str(record, 'status')
              const mark = status === 'completed' ? '✓' : status === 'in_progress' ? '◐' : '○'
              return content ? `${mark} ${preview(content, 80)}` : null
            })
            .filter((line): line is string => line !== null)
          if (lines.length > 0) this.pushSystem(`待办（${lines.length}）：${lines.slice(0, 5).join(' · ')}`)
          else this.version++
        }
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
    this.advanceSeal()
  }

  /**
   * A row is final once nothing will append to it again: finished tool cards,
   * sealed thoughts, and any non-open assistant/user/system row. The open
   * assistant row (still streaming) and pinned chrome rows hold the seal.
   */
  private isRowFinal(row: TranscriptRow): boolean {
    if (row.pinned === true) return false
    switch (row.kind) {
      case 'tool':
        return row.status === 'ok' || row.status === 'failed'
      case 'thought':
        return row.seconds !== undefined
      default:
        return row.id !== this.openAssistantId
    }
  }

  /**
   * Raise `sealedRowCount` to the leading run of final rows. Called after
   * every projection mutation so finished rows sediment into scrollback
   * continuously instead of waiting for the next turn boundary.
   */
  private advanceSeal(): void {
    let n = this.sealedRowCount
    const rows = this.rows
    while (n < rows.length) {
      const row = rows[n]
      if (!row || !this.isRowFinal(row)) break
      n++
    }
    if (n > this.sealedRowCount) {
      this.sealedRowCount = n
      this.version++
    }
  }

  /** A user prompt submitted from the editor (used by tests and the fake kernel). */
  pushUser(text: string): void {
    this.sealThought()
    this.openAssistantId = null
    this.rows.push({ id: ++rowId, kind: 'user', text, seq: ++this.version })
    this.advanceSeal()
  }

  /** Local notice (connection loss, resume hint, …) — never model-visible. */
  pushSystem(text: string): void {
    this.rows.push({ id: ++rowId, kind: 'system', text, seq: ++this.version })
    this.advanceSeal()
  }

  /**
   * Pre-rendered chrome lines (welcome card, route lines) pushed verbatim.
   * Pinned rows stay in the live region — visible chrome — until the first
   * `turn/start` seal-all flushes them together with the turn's content, so
   * they age into scrollback in log order instead of vanishing.
   */
  pushRaw(lines: readonly string[], pinned = false): void {
    const row: TranscriptRow = { id: ++rowId, kind: 'system', text: '', rawLines: lines, seq: ++this.version }
    if (pinned) row.pinned = true
    this.rows.push(row)
    if (!pinned) this.advanceSeal()
  }

  /**
   * Reset the view for a session switch (`/new`, `/resume`, rewind fork).
   * The durable logs stay on disk; only the live projection is replaced.
   * Usage/route/title reset — the new session's `request/header` and
   * `session/title` events repopulate them.
   */
  clearForSwitch(): void {
    this.rows.length = 0
    this.sealedRowCount = 0
    this.openAssistantId = null
    this.openThoughtId = null
    this.runState = 'idle'
    this.route = null
    this.usage = { input: 0, output: 0, reasoning: 0, messages: 0 }
    this.title = null
    this.compacting = false
    this.lastSeq = null
    this.turnSeqs = []
    this.version++
  }

  /** Replay a persisted log into this projection (resume without live events). */
  replay(events: readonly SessionEvent[]): void {
    for (const event of events) this.ingest(event)
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
