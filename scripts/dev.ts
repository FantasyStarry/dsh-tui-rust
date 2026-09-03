/**
 * Headless smoke harness: `pnpm dev` boots the real bootstrap path against a
 * fake kernel. Phases, all through the same seams the kernel uses:
 *
 *   Phase 0 — the Config Standard Schema contract (cordis resolveConfig).
 *   Phase 1 — degraded boot (#183): `agents` unmounted → one system row.
 *   Phase 2 — mounted fake kernel implementing the REAL dsh contract
 *             (v0.1.1-rc.2): factory race retry → connect → keyboard-driven
 *             `followup(UserMessage)` → session envelope projection
 *             (`request/header`, text/reasoning deltas, tool rows,
 *             `assistant/message` usage, thought collapse) → `/model`
 *             three-stage picker (provider → model → effort) → waterfall
 *             override verified against the captured listener → dispose.
 *
 * Exits non-zero on failure — CI-usable. A real-TTY run is still required
 * for keyboard/rendering feel; this harness only proves plumbing.
 */

import { EventEmitter } from 'node:events'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrapApp } from '../src/app.js'
import { Config } from '../src/index.js'
import type { OrcaConfig } from '../src/index.js'
import { Renderer } from '../src/tui/renderer.js'
import { buildFrame } from '../src/tui/chat.js'
import type {
  AgentHandle,
  CreateAgentOptions,
  KernelAgentsService,
  KernelContext,
  ResumeAgentOptions,
  Session,
  SessionEvent,
  UserMessage,
} from '../src/kernel/types.js'

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Minimal terminal emulator for the renderer contract: replays the write
 * stream (cursor up/down, clear-line, clear-to-end, newline) onto a screen
 * buffer so tests can assert the VISIBLE frame, not just that bytes moved.
 * SGR color pairs are STRIPPED here (assertions target visible text, never
 * raw escape boundaries), and the CSI-2026 sync pair pass through as no-ops.
 */
/**
 * Minimal terminal emulator for the renderer contract: replays the write
 * stream (cursor up/down, clear-line, clear-to-end, newline) onto a screen
 * buffer so tests can assert the VISIBLE frame, not just that bytes moved.
 * SGR color pairs are STRIPPED here (assertions target visible text, never
 * raw escape boundaries), and the CSI-2026 sync pair pass through as no-ops.
 * With `height` set, newlines past the bottom SCROLL (top row drops) — the
 * real-terminal behavior the chrome-drift regressions hinge on.
 */
function paintScreen(writes: string[], height = Number.POSITIVE_INFINITY): string[] {
  const screen: string[] = ['']
  let row = 0
  const stream = writes.join('')
  const re = /\x1b\[\??[0-9]*([ABlJK])|\x1b\[\??[0-9]*[HG]|\x1b\[\?2026[hl]|\r\n|\r/g
  let last = 0
  let match: RegExpExecArray | null
  const writeText = (text: string): void => {
    const plain = text.replace(/\x1b\[[0-9;?]*[@-~]/g, '')
    while (screen.length <= row) screen.push('')
    screen[row] += plain
  }
  const lineFeed = (): void => {
    if (row + 1 >= height) {
      screen.shift()
      while (screen.length < height) screen.push('')
      row = height - 1
      return
    }
    row++
    while (screen.length <= row) screen.push('')
  }
  while ((match = re.exec(stream)) !== null) {
    writeText(stream.slice(last, match.index))
    last = re.lastIndex
    const code = match[1]
    if (code === 'A') {
      const param = /\x1b\[\??([0-9]*)A/.exec(match[0])?.[1] ?? '1'
      row = Math.max(0, row - (param === '' ? 1 : Number.parseInt(param, 10)))
    } else if (code === 'B') {
      const param = /\x1b\[\??([0-9]*)B/.exec(match[0])?.[1] ?? '1'
      row += param === '' ? 1 : Number.parseInt(param, 10)
    } else if (code === 'J') {
      // ESC[0J — clear the current line and everything below it.
      screen.length = row + 1
      screen[row] = ''
    } else if (code === 'K') {
      while (screen.length <= row) screen.push('')
      screen[row] = ''
    } else if (match[0] === '\r\n') {
      lineFeed()
    }
    // lone '\r' and the sync pair: no-ops under the full-line write model
  }
  writeText(stream.slice(last))
  return screen
}

function makeStdout(writes: string[]): NodeJS.WriteStream {
  return {
    columns: 100,
    write(chunk: string): boolean {
      writes.push(chunk)
      return true
    },
  } as unknown as NodeJS.WriteStream
}

/** Remove CSI sequences (SGR + cursor moves) so assertions read visible text. */
function stripSgr(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[@-~]/g, '')
}

/**
 * Fake TTY stdin: feeds RAW byte sequences ('data' chunks) so the smoke
 * drives the real Keyboard parser — the same escape decoding the terminal
 * exercises, not a keypress-event bypass.
 */
class FakeStdin extends EventEmitter {
  isTTY = true
  setRawMode(mode: boolean): boolean {
    return mode
  }
  resume(): void {}
  pause(): void {}

  private write(text: string): void {
    this.emit('data', Buffer.from(text, 'utf8'))
  }

  /** A named key (return / escape / up / down / tab / backspace …). */
  key(name: string, opts: { ctrl?: boolean } = {}): void {
    if (opts.ctrl) {
      this.write(String.fromCharCode(name.toLowerCase().charCodeAt(0) - 0x60))
      return
    }
    if (name === 'return') this.write('\r')
    else if (name === 'escape') this.write('\x1b')
    else if (name === 'tab') this.write('\t')
    else if (name === 'backspace') this.write('\x7f')
    else if (name === 'up') this.write('\x1b[A')
    else if (name === 'down') this.write('\x1b[B')
    else if (name === 'left') this.write('\x1b[D')
    else if (name === 'right') this.write('\x1b[C')
    else this.write(name)
  }

  /** Plain text (printable sequence, CJK included) as one burst. */
  text(sequence: string): void {
    this.write(sequence)
  }
}

interface KernelRecord {
  createOptions: CreateAgentOptions | null
  createCalls: number
  resumedId: string | null
  followupMessage: UserMessage | null
  cancelCause: { kind: string } | null
  selectionSaved: { provider: string; model: string; reasoningEffort?: string } | null
  requestListener: ((...args: unknown[]) => unknown) | null
  approvalListener: ((...args: unknown[]) => unknown) | null
  policySet: string | null
  titleRenamed: string | null
  compactLine: string | null
  forkCalled: { boundary: number | undefined; childId: string | undefined } | null
  disposed: boolean
}

/**
 * Fake kernel context. `mounted` decides whether the kernel services exist;
 * when mounted they implement the REAL contract shapes and the fake agent
 * streams a scripted turn through the real session-event envelope.
 */
class FakeKernel implements KernelContext {
  readonly record: KernelRecord = {
    createOptions: null,
    createCalls: 0,
    resumedId: null,
    followupMessage: null,
    cancelCause: null,
    selectionSaved: null,
    requestListener: null,
    approvalListener: null,
    policySet: null,
    titleRenamed: null,
    compactLine: null,
    forkCalled: null,
    disposed: false,
  }
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private seq = 0
  private factoryCalls = 0
  private fakePolicy = 'ask'
  private fakeTitle: string | null = null
  /** When true, `sessionQuery` reads as unregistered (late-registration probe). */
  hideSessionQuery = false
  /** Live agents by session id (removed on dispose, like the real store). */
  private readonly liveAgents = new Map<string, AgentHandle['agent']>()
  /** Sessions durable on "disk" (survive dispose, loadable via resume). */
  private readonly persistedSessions = new Set<string>()

  constructor(private readonly mounted: boolean) {}

  on(name: string, listener: (...args: unknown[]) => unknown): () => void {
    const set = this.listeners.get(name) ?? new Set()
    set.add(listener)
    this.listeners.set(name, set)
    return () => {
      this.listeners.get(name)?.delete(listener)
    }
  }

  get<T = unknown>(name: string, _soft?: false): T | undefined {
    if (!this.mounted) return undefined
    if (name === 'agents') return this.agentsService as T
    if (name === 'loader') return { await: async (): Promise<void> => {} } as T
    if (name === 'agentDefaultModel') {
      return {
        currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
        saveSelection: async (next: { provider: string; model: string; reasoningEffort?: string }): Promise<void> => {
          this.record.selectionSaved = next
        },
      } as T
    }
    if (name === 'llm') {
      return {
        listProviders: () => [
          { id: 'fake-a', name: 'Fake A' },
          { id: 'fake-b', name: 'Fake B' },
        ],
        listModels: async (provider: string) => [
          { provider, id: `${provider}-m1`, name: `${provider} 模型一` },
          { provider, id: `${provider}-m2`, name: `${provider} 模型二` },
        ],
        resolveModel: async (provider: string, model: string) => ({
          provider,
          id: model,
          name: model,
          reasoning: {
            efforts: [
              { id: 'low', name: '低' },
              { id: 'high', name: '高' },
            ],
            defaultEffort: 'low',
          },
        }),
      } as T
    }
    if (name === 'sessionQuery') {
      if (this.hideSessionQuery) return undefined
      return {
        listSessions: async () => [
          { header: { id: 'session-aaa', cwd: '/tmp/proj', createdAt: Date.now() - 1000 }, live: false, persisted: true },
          { header: { id: 'session-bbb', cwd: '/tmp/proj', createdAt: Date.now() - 2000 }, live: false, persisted: true },
        ],
        readTitle: async (sessionId: string) =>
          sessionId === 'session-aaa' ? { title: '假标题A', updatedAt: Date.now() } : undefined,
        readTitleSnapshots: async (ids: readonly string[]) =>
          ids.map((sessionId) => ({
            sessionId,
            status: 'fulfilled' as const,
            value: sessionId === 'session-aaa' ? { title: { title: '假标题A', updatedAt: Date.now() } } : {},
          })),
        readSession: async (_sessionId: string) => ({
          events: [
            { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } },
            {
              type: 'user/message',
              seq: 1,
              time: Date.now(),
              data: { content: [{ type: 'text', text: 'hi 历史' }], source: { kind: 'user' } },
            },
            { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } },
          ],
        }),
      } as T
    }
    if (name === 'sessionTitle') {
      return {
        get: () => (this.fakeTitle ? { title: this.fakeTitle, updatedAt: Date.now() } : undefined),
        rename: (_session: unknown, title: string) => {
          this.record.titleRenamed = title
          this.fakeTitle = title
          return { title, updatedAt: Date.now() }
        },
        refresh: async () => undefined,
      } as T
    }
    if (name === 'commands') {
      return {
        list: () => [{ name: 'compact', description: '压缩上下文' }],
        find: (_agent: unknown, cmdName: string) => (cmdName === 'compact' ? { name: 'compact' } : undefined),
        execute: async (_agent: unknown, line: string) => {
          this.record.compactLine = line
          return { commandId: 'cmd-1', result: { kind: 'success' as const, text: '压缩已开始' } }
        },
      } as T
    }
    if (name === 'approval') {
      return {
        setPolicy: (_agent: unknown, policy: string) => {
          this.record.policySet = policy
          this.fakePolicy = policy
        },
        overrideOf: () => this.fakePolicy,
        request: async () => 'unavailable' as const,
      } as T
    }
    if (name === 'sessions') {
      return {
        fork: (_source: unknown, boundary?: number, childSessionId?: string) => {
          this.record.forkCalled = { boundary, childId: childSessionId }
          return { id: childSessionId ?? 'session-fork' }
        },
      } as T
    }
    return undefined
  }

  effect(_register: () => (() => void) | void): void {
    // Effects are lifecycle-managed by the real kernel; smoke ignores them.
  }

  /** Publish one session event through the real `(session, event)` shape. */
  emit(type: string, data: unknown): void {
    const event: SessionEvent = { type, seq: this.seq++, time: Date.now(), data }
    for (const listener of this.listeners.get('session/event') ?? []) {
      listener({ id: 'fake-session' }, event)
    }
  }

  private readonly agentsService: KernelAgentsService = {
    create: async (options: CreateAgentOptions): Promise<AgentHandle> => {
      // First call hits the verified boot race: the registry exists before
      // dsh-agent-loop registers the factory. The app must retry, not fail.
      this.factoryCalls++
      if (this.factoryCalls === 1) {
        throw new Error('no agent factory registered (load an agent-loop plugin)')
      }
      this.record.createOptions = options
      this.record.createCalls++
      const kernel = this
      const session: Session = {
        id: options.sessionId,
        events: [],
        append(type, data): SessionEvent {
          return { type, seq: kernel.seq++, time: Date.now(), data }
        },
      }
      const agent = {
        id: options.sessionId,
        options: options.agentOptions ?? {},
        session,
        status: 'idle' as const,
        ctx: {
          on(name: string, listener: (...args: unknown[]) => unknown): () => void {
            if (name === 'agent/request') kernel.record.requestListener = listener
            if (name === 'approval/request') kernel.record.approvalListener = listener
            return () => {}
          },
        },
        followup(message: UserMessage): void {
          kernel.record.followupMessage = message
          kernel.streamTurn(message)
        },
        steer(_message: UserMessage): void {},
        inject(_message: UserMessage): void {},
        cancel(cause: { kind: string }): void {
          kernel.record.cancelCause = cause
        },
        whenIdle: async (): Promise<void> => {},
      }
      kernel.liveAgents.set(options.sessionId, agent)
      kernel.persistedSessions.add(options.sessionId)
      return {
        agent,
        dispose: async (): Promise<void> => {
          kernel.record.disposed = true
          kernel.liveAgents.delete(options.sessionId)
        },
      }
    },
    resume: async (options: ResumeAgentOptions): Promise<AgentHandle> => {
      // Unknown sessions reject like the real persistence backend; each fake
      // kernel owns its persistence, so cross-kernel resumes fail and the app
      // must fall back to a fresh create.
      if (!this.persistedSessions.has(options.resumeSessionId)) {
        throw new Error(`session not found: ${options.resumeSessionId}`)
      }
      this.record.resumedId = options.resumeSessionId
      return this.agentsService.create({ sessionId: options.resumeSessionId, agentOptions: options.agentOptions })
    },
    get: (id: string) => this.liveAgents.get(id) as AgentHandle['agent'] | undefined,
    list: () => [...this.liveAgents.values()] as Array<AgentHandle['agent']>,
  }

  /**
   * A scripted turn streamed the way the kernel would: the real envelope
   * (`{type, seq, time, data}`) — `request/header` route snapshot,
   * `assistant/chunk` text/reasoning deltas, tool lifecycle, and an
   * `assistant/message` carrying `usage`.
   */
  private streamTurn(message: UserMessage): void {
    const turn = 1
    const step = 1
    const at = (delay: number, type: string, data: unknown): void => {
      setTimeout(() => this.emit(type, data), delay)
    }
    at(0, 'turn/start', { turn })
    at(10, 'user/message', message)
    at(20, 'request/header', {
      header: { config: { provider: 'default-provider', model: 'default-model' } },
      reason: 'initial',
    })
    at(40, 'assistant/chunk', { turn, step, chunk: { type: 'text-delta', index: 0, text: '**你好**，Orca。\n\n- 列表一\n- 列表二\n\n```ts\nconst n = 1 // 注释\n```\n\n流式增量上屏测试。' } })
    at(150, 'assistant/chunk', { turn, step, chunk: { type: 'reasoning-delta', index: 1, text: '思考一下。' } })
    at(200, 'tool/call', { turn, step, callId: 'call-1', name: 'edit', arguments: '{"path":"src/app.ts"}' })
    at(260, 'tool/result', {
      turn,
      step,
      message: {
        id: 'msg-result-1',
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: 'call-1' },
      },
      meta: { diffs: [{ path: 'src/app.ts', oldText: 'const a = 1\n', newText: 'const a = 2\nconst b = 3\n' }] },
    })
    at(560, 'assistant/message', {
      turn,
      step,
      message: {
        id: 'msg-assistant-1',
        role: 'assistant',
        content: [{ type: 'text', text: '**你好**，Orca。\n\n- 列表一\n- 列表二\n\n```ts\nconst n = 1 // 注释\n```\n\n流式增量上屏测试。' }],
        source: { kind: 'model', provider: 'default-provider', model: 'default-model' },
      },
      usage: { inputTokens: 120, outputTokens: 45, reasoningTokens: 30 },
    })
    at(600, 'turn/end', { turn, reason: { kind: 'completed' } })
  }
}

async function main(): Promise<void> {
  const problems: string[] = []
  // Sandbox the same-process remount marker: the harness mounts several
  // bootstraps in ONE process, and without isolation every later mount
  // would silently resume the first mount's session.
  process.env['ORCA_LAST_SESSION_FILE'] = join(tmpdir(), `orca-smoke-${process.pid}.json`)
  try {
    rmSync(process.env['ORCA_LAST_SESSION_FILE'])
  } catch {
    // Absent on the first run — nothing to clear.
  }

  // ── Phase 0: the Config Standard Schema contract ──────────────────────────
  const schema = Config['~standard']
  const valueOf = (result: { value?: unknown }): OrcaConfig | undefined =>
    typeof result.value === 'object' && result.value !== null ? (result.value as OrcaConfig) : undefined
  const filled = valueOf(schema.validate({ provider: 'p1', fullscreen: 'yes' as unknown as boolean }))
  if (schema.version !== 1 || filled?.provider !== 'p1' || filled.fullscreen !== false) {
    problems.push('phase0：Config 校验未按 Standard Schema 收敛')
  }
  const empty = valueOf(schema.validate(undefined))
  if (empty?.provider !== '' || empty.model !== '' || empty.fullscreen !== false) {
    problems.push('phase0：Config 缺省校验失败')
  }

  // ── Phase 0.5: renderer contract — the diff painter must reproduce the
  // frame on screen: live append, the scrollback-seal stream path (sealed
  // lines land between previously sealed content and the live rows, in
  // order), and post-seal live growth.
  {
    const rw: string[] = []
    const renderer = new Renderer(makeStdout(rw), () => 80)
    renderer.render(['a1', 'a2']) // first frame
    renderer.render(['a1', 'a2', 'a3']) // live append below
    renderer.render(['a3'], ['s1', 's2']) // seal flush: sealed at top of tracked region
    renderer.render(['a3', 'a4']) // post-seal live growth
    renderer.render(['a5'], ['s3']) // second seal (replaces the sealed row's open text)
    const screen = paintScreen(rw)
    renderer.dispose()
    while (screen.length > 0 && screen[screen.length - 1] === '') screen.pop()
    const expected = 's1\ns2\ns3\na5'
    if (screen.join('\n') !== expected) problems.push(`phase0.5：渲染契约失真：${JSON.stringify(screen)}`)
  }

  // ── Phase 0.7: picker height contract — model lists must not push the
  // editor/footer below the terminal viewport (the source of ghost chrome
  // after closing /model on a short terminal).
  {
    const picker = {
      title: '选择模型（provider）',
      items: Array.from({ length: 40 }, (_, i) => ({ value: `m${i}`, label: `model-${i}` })),
      index: 20,
    }
    const frame = buildFrame({
      channel: {
        rows: [], sealedRowCount: 0, runState: 'idle', route: null,
        usage: { input: 0, output: 0, reasoning: 0, messages: 0 },
      } as never,
      sealedFrom: 0,
      editorText: '',
      width: 80,
      height: 12,
      cwd: '.',
      sessionId: null,
      route: null,
      usage: { input: 0, output: 0, reasoning: 0, messages: 0 },
      now: Date.now(),
      picker,
    })
    if (frame.live.length > 12) problems.push(`phase0.7：选择器溢出终端高度：${frame.live.length}`)

    const reserved = buildFrame({
      channel: {
        rows: [], sealedRowCount: 0, runState: 'idle', route: null,
        usage: { input: 0, output: 0, reasoning: 0, messages: 0 },
      } as never,
      sealedFrom: 0,
      editorText: '',
      width: 80,
      height: 12,
      reservedRows: 5,
      cwd: '.',
      sessionId: null,
      route: null,
      usage: { input: 0, output: 0, reasoning: 0, messages: 0 },
      now: Date.now(),
      picker,
    })
    if (reserved.live.length + 5 > 12) problems.push(`phase0.7：已有 scrollback 偏移时选择器溢出：${reserved.live.length}`)
  }

  // ── Phase 0.75: historical welcome rows do not permanently reserve
  // viewport height once conversation content starts streaming.
  {
    const channel = {
      rows: [{ kind: 'user', text: '你好' }],
      sealedRowCount: 0,
      runState: 'thinking',
      route: null,
      usage: { input: 0, output: 0, reasoning: 0, messages: 1 },
    } as never
    const frame = buildFrame({
      channel,
      sealedFrom: 0,
      editorText: '',
      width: 80,
      height: 24,
      reservedRows: 0,
      anchorChrome: true,
      cwd: '.',
      sessionId: null,
      route: null,
      usage: { input: 0, output: 0, reasoning: 0, messages: 1 },
      now: Date.now(),
      picker: null,
    })
    if (frame.live.length !== 24) problems.push(`phase0.75：聊天态未填满底部 chrome：${frame.live.length}`)
    if (frame.live.at(-5) === undefined || !frame.live.at(-5)?.includes('╭')) problems.push('phase0.75：输入框未锚定到底部')
  }

  // ── Phase 0.8: closing /model with a route stream must remove the old
  // picker border instead of leaving it above the replacement editor.
  {
    const rw: string[] = []
    const renderer = new Renderer(makeStdout(rw), () => 80)
    const cursor = { fromEnd: 3, col: 5 }
    renderer.render(['picker-top', 'picker-row', 'picker-bottom', '╭────╮', '│ >  │', '╰────╯', 'footer-1', 'footer-2'], [], cursor)
    renderer.render(['system: 模型已切换', '╭────╮', '│ >  │', '╰────╯', 'footer-1', 'footer-2'], ['↳ 模型 provider/model'], cursor)
    const screen = paintScreen(rw)
    const visible = screen.join('\n')
    if (visible.includes('picker-top') || visible.includes('picker-row')) {
      problems.push(`phase0.8：关闭 picker 后残留旧边框：${JSON.stringify(screen)}`)
    }
  }


  // ── Phase 0.6: full-height repaint must NOT scroll — the last frame row
  // carries no trailing newline, so a top-row change on a screen-filling
  // frame keeps every row visible (the chrome-drift regression).
  {
    const rw: string[] = []
    const renderer = new Renderer(makeStdout(rw), () => 40)
    const cursor = { fromEnd: 0, col: 3 }
    renderer.render(['a1', 'a2', 'a3', 'a4'], [], cursor) // fills a 4-row screen
    renderer.render(['b1', 'a2', 'a3', 'a4'], [], cursor) // top-row change → full repaint
    renderer.render(['b1', 'a2', 'a3', 'c4'], [], cursor) // tail change
    renderer.render(['b1', 'a2', 'a3', 'c4'], ['s1', 's2'], cursor) // seal flush above
    const screen = paintScreen(rw, 4)
    renderer.dispose()
    // The seal rows overflow a full screen into scrollback; the frame itself
    // must come through intact — no lost top row, no drift, no stale tail.
    if (screen.join('\n') !== 'b1\na2\na3\nc4') problems.push(`phase0.6：整屏重绘丢行/漂移：${JSON.stringify(screen)}`)
  }

  // ── Phase 0.65: expanding from the post-stream live height to a full
  // viewport must repaint as a frame, keeping the input at the bottom.
  {
    const rw: string[] = []
    const renderer = new Renderer(makeStdout(rw), () => 40)
    const cursor = { fromEnd: 3, col: 5 }
    renderer.render(['old-1', 'old-2', 'old-3', 'old-input', 'old-f1', 'old-f2'], ['welcome-1', 'welcome-2'], cursor)
    renderer.render(['', '', '', '', 'new-1', 'new-2', 'new-3', 'new-input', 'new-f1', 'new-f2'], [], cursor)
    const screen = paintScreen(rw, 10)
    const tail = screen.slice(-5).join('\n')
    if (!tail.includes('new-input') || !tail.includes('new-f2')) problems.push(`phase0.65：live 扩展后 chrome 未锚底：${JSON.stringify(screen)}`)
  }

  // ── Phase 1: degraded boot (#183) — no `agents` service, never a throw ───
  const writes1: string[] = []
  const kernel1 = new FakeKernel(false)
  const dispose1 = bootstrapApp(
    kernel1,
    { provider: '', model: '', fullscreen: false },
    { stdout: () => makeStdout(writes1), stdin: () => new FakeStdin() },
  )
  await sleep(150)
  dispose1()
  const painted1 = writes1.join('')
  const visible1 = stripSgr(painted1)
  if (writes1.length === 0) problems.push('phase1：没有帧写入')
  if (!visible1.includes('agents` 未挂载')) problems.push('phase1：降级启动提示缺失')

  // ── Phase 2: mounted fake kernel, real contract, real keyboard drive ────
  const writes2: string[] = []
  const stdin2 = new FakeStdin()
  const kernel2 = new FakeKernel(true)
  const dispose2 = bootstrapApp(
    kernel2,
    // Empty provider/model: the composition default (agentDefaultModel) must
    // be picked up — the exact path the real profile exercises.
    { provider: '', model: '', fullscreen: false },
    { stdout: () => makeStdout(writes2), stdin: () => stdin2 },
  )
  await sleep(250) // create() retries once (factory pending), then connects
  stdin2.key('escape') // Esc with an empty editor → agent.cancel({kind:'user'})
  for (const ch of '帮我看看') stdin2.text(ch)
  stdin2.key('return')
  await sleep(850) // the scripted turn streams through (incl. usage @560ms)
  if (!stripSgr(writes2.join('')).includes('思考中')) problems.push('phase2：思考中状态未上屏')

  // Type + backspace WITHOUT submitting: the chrome must stay a single copy.
  // Regression guard for cursor-accounted repaints — when the painter forgot
  // where placeCursor left the cursor, every keystroke smeared a new
  // hint+footer block down the screen.
  stdin2.text('试')
  await sleep(100)
  stdin2.key('backspace')
  await sleep(100)
  {
    const snap = paintScreen(writes2)
    const countOf = (needle: string): number => snap.filter((row) => row.includes(needle)).length
    if (countOf('> 说点什么...') !== 1) problems.push('phase2：编辑后输入行重复/缺失')
    if (countOf('Enter 发送') !== 1) problems.push('phase2：编辑后提示行重复/缺失')
    if (snap.some((row) => row.includes('思考中...'))) problems.push('phase2：idle 页脚不应显示思考中徽标')
    if (!snap.some((row) => row.includes('context: ↑120'))) problems.push('phase2：turn/end 后用量未上屏')
    if (snap.some((row) => row.includes('试说'))) problems.push('phase2：退格后占位符残留输入字符')
  }

  // /model picker: open → provider → model → effort(down to 低) → applied
  for (const ch of '/model') stdin2.text(ch)
  stdin2.key('return')
  await sleep(150) // provider list loads
  stdin2.key('return') // pick Fake A
  await sleep(150) // model list loads
  stdin2.key('return') // pick fake-a-m1
  await sleep(150) // efforts load
  stdin2.key('down') // move to 低
  stdin2.key('return') // pick 低
  await sleep(250) // selection applies + saveSelection settles

  // Arrow keys in the editor must no-op, never smear CSI garbage into the
  // prompt — regression guard for the navigate classification. Submitted
  // text must be exactly 'q1'.
  for (const ch of 'q1') stdin2.text(ch)
  stdin2.key('up')
  stdin2.key('return')
  await sleep(120)
  // Snapshot BEFORE dispose: dispose intentionally wipes the live region
  // (including the footer) — the final chrome check targets the live UI.
  const rows2 = paintScreen(writes2)
  dispose2()
  await sleep(20) // handle.dispose() settles

  const painted2 = writes2.join('')
  const visible2 = stripSgr(painted2)
  const record = kernel2.record
  if (writes2.length === 0) problems.push('phase2：没有帧写入')
  if (visible2.includes('agent 启动失败')) problems.push('phase2：工厂未就绪竞态未被重试吸收')
  if (!visible2.includes('session 已连接')) problems.push('phase2：session 连接提示缺失')
  if (!visible2.includes('帮我看看')) problems.push('phase2：user/message 未投影（session 非真源）')
  if (!visible2.includes('你好，Orca。')) problems.push('phase2：assistant 流式转录缺失')
  if (!visible2.includes('流式增量上屏测试。')) problems.push('phase2：增量 chunk 未并入同一行')
  if (!visible2.includes('• 列表一') || !visible2.includes('• 列表二')) problems.push('phase2：markdown 列表未渲染')
  if (!visible2.includes('╭─ ts ')) problems.push('phase2：围栏代码块未渲染')
  if (!visible2.includes('const n = 1')) problems.push('phase2：代码行未渲染')
  if (!visible2.includes('思考一下。')) problems.push('phase2：reasoning-delta 未进思考行')
  if (!/已思考 \d+(\.\d+)?s/.test(visible2)) problems.push('phase2：思考块未折叠为时长摘要')
  if (!visible2.includes('✓ edit src/app.ts')) problems.push('phase2：工具 diff 卡头未渲染')
  if (!visible2.includes('+ const a = 2') || !visible2.includes('- const a = 1')) problems.push('phase2：diff 增删行未着色渲染')
  if (!visible2.includes('+ const b = 3')) problems.push('phase2：diff 新增行缺失')
  if (!visible2.includes('✦ orca')) problems.push('phase2：欢迎区缺失')
  if (!visible2.includes('Directory:')) problems.push('phase2：欢迎区信息行缺失')
  if (!visible2.includes('↳ 模型 default-provider/default-model')) problems.push('phase2：路由线未打印')
  if (!visible2.includes('default-provider/default-model')) problems.push('phase2：页脚未显示 request/header 路由')
  if (!visible2.includes('↑120') || !visible2.includes('↓45')) problems.push('phase2：token 用量未上屏')
  for (const expect of ['选择 Provider', '选择模型（fake-a）', '选择思考强度（fake-a-m1）', '模型已切换：fake-a/fake-a-m1(low)']) {
    if (!visible2.includes(expect)) problems.push(`phase2：/model 流程缺少「${expect}」`)
  }
  if (record.selectionSaved?.provider !== 'fake-a' || record.selectionSaved.model !== 'fake-a-m1' || record.selectionSaved.reasoningEffort !== 'low') {
    problems.push('phase2：saveSelection 未持久化选择')
  }
  const listener = record.requestListener
  if (!listener) {
    problems.push('phase2：agent/request waterfall 监听未注册')
  } else {
    const rewritten = (await listener({}, async () => ({ provider: 'x', model: 'y', reasoningEffort: 'old' }))) as Record<string, unknown>
    if (rewritten['provider'] !== 'fake-a' || rewritten['model'] !== 'fake-a-m1' || rewritten['reasoningEffort'] !== 'low') {
      problems.push('phase2：waterfall 未按选择改写请求路由')
    }
  }
  if (record.createOptions === null || !/^session-/.test(record.createOptions.sessionId)) {
    problems.push('phase2：create 未收到规范的 sessionId')
  }
  if (record.createOptions?.meta?.cwd !== process.cwd()) problems.push('phase2：create 未携带 cwd')
  if (record.createOptions?.agentOptions?.provider !== 'default-provider') problems.push('phase2：agentOptions.provider 未取组合默认路由')
  if (record.createOptions?.agentOptions?.model !== 'default-model') problems.push('phase2：agentOptions.model 未取组合默认模型')
  // The LAST followup is the arrow-guard submit; its text proves the editor
  // stayed clean ('帮我看看' projection is asserted via the painted frames).
  const lastFollowup = record.followupMessage
  const lastBlock = lastFollowup?.content[0]
  if (lastBlock?.type !== 'text' || lastBlock.text !== 'q1') {
    problems.push(`phase2：编辑器方向键混入转义垃圾：${JSON.stringify(lastFollowup ?? null)}`)
  }
  if (lastFollowup?.source['kind'] !== 'user') problems.push('phase2：followup 消息缺 user 来源')
  if (record.cancelCause?.kind !== 'user') problems.push('phase2：cancel 未携带 user 原因')
  if (!record.disposed) problems.push('phase2：dispose 未触达 handle.dispose')

  // Final VISIBLE screen tail must be the intact bottom chrome: editor box
  // (top → prompt → bottom) + footer L1 → L2, each exactly once.
  while (rows2.length > 0 && rows2[rows2.length - 1] === '') rows2.pop()
  const tail = rows2.slice(-5)
  const hint = 'Enter 发送  ·  /model 模型  ·  Ctrl+O 思考  ·  Esc 取消  ·  Ctrl+C 退出'
  if (tail.length !== 5) problems.push(`phase2：最终画面尾部不足 5 行：${JSON.stringify(rows2.slice(-7))}`)
  const promptRow = rows2.find((row) => row.includes('> 说点什么...'))
  if (promptRow === undefined) {
    problems.push(`phase2：输入行不完整：${JSON.stringify(rows2.slice(-8))}`)
  }
  if (!rows2.some((row) => row.includes(hint))) problems.push(`phase2：提示行缺失或不唯一：${JSON.stringify(tail)}`)
  // The q1 submit opened the second turn — the footer badge is mid-turn here.
  const footerRow = rows2.find((row) => row.includes('思考中...'))
  if (footerRow === undefined) problems.push(`phase2：页脚缺失或状态不符：${JSON.stringify(tail)}`)
  // The /model switch happened before q1 — the footer must show the LIVE selection.
  if (footerRow === undefined || !footerRow.includes('fake-a/fake-a-m1(low)')) problems.push(`phase2：页脚未反映切换后路由：${JSON.stringify(footerRow)}`)

  // ── Phase 3: M3 会话命令 + M4 审批/压缩/hook/回退 ──────────────────────────
  const writes3: string[] = []
  const stdin3 = new FakeStdin()
  const kernel3 = new FakeKernel(true)
  const dispose3 = bootstrapApp(
    kernel3,
    { provider: '', model: '', fullscreen: false },
    { stdout: () => makeStdout(writes3), stdin: () => stdin3 },
  )
  await sleep(250)
  const visible3 = (): string => stripSgr(writes3.join(''))
  const typeLine = async (line: string): Promise<void> => {
    for (const ch of line) stdin3.text(ch)
    stdin3.key('return')
    await sleep(120)
  }

  await typeLine('/help')
  if (!visible3().includes('可用命令') || !visible3().includes('/resume')) problems.push('phase3：/help 未列出会话命令')
  await typeLine('/usage')
  if (!visible3().includes('用量')) problems.push('phase3：/usage 未上屏')
  await typeLine('/title 新标题')
  if (kernel3.record.titleRenamed !== '新标题') problems.push('phase3：/title 未调用 rename')
  if (!visible3().includes('标题已更新')) problems.push('phase3：/title 确认缺失')
  await typeLine('/title')
  if (!visible3().includes('会话标题')) problems.push('phase3：/title 查看缺失')
  await typeLine('/yolo on')
  if (!visible3().includes('yolo 已开启')) problems.push('phase3：/yolo on 未上屏')
  // Yolo auto-allow: the waterfall resolves without any panel.
  {
    const listener = kernel3.record.approvalListener
    if (!listener) problems.push('phase3：approval waterfall 未注册')
    else {
      const outcome = (await listener({ toolName: 'read', reason: '单测' }, async () => 'rejected')) as string
      if (outcome !== 'allowed-once') problems.push(`phase3：yolo 未自动放行：${outcome}`)
    }
  }
  await typeLine('/yolo off')
  if (!visible3().includes('yolo 已关闭')) problems.push('phase3：/yolo off 未上屏')
  // Panel path: the ask pends, the picker shows, `1` allows.
  {
    const listener = kernel3.record.approvalListener
    if (listener) {
      const pending = listener({ toolName: 'edit', reason: '改文件' }, async () => 'rejected') as Promise<string>
      await sleep(150)
      if (!visible3().includes('审批：edit')) problems.push('phase3：审批面板未上屏')
      stdin3.text('1')
      await sleep(100)
      const outcome = await pending
      if (outcome !== 'allowed-once') problems.push(`phase3：面板按 1 未放行：${outcome}`)
    }
  }
  // Esc on the panel rejects.
  {
    const listener = kernel3.record.approvalListener
    if (listener) {
      const pending = listener({ toolName: 'bash', reason: '跑命令' }, async () => 'allowed-once') as Promise<string>
      await sleep(150)
      stdin3.key('escape')
      await sleep(100)
      const outcome = await pending
      if (outcome !== 'rejected') problems.push(`phase3：面板 Esc 未拒绝：${outcome}`)
    }
  }
  await typeLine('/permission')
  if (!visible3().includes('审批策略')) problems.push('phase3：/permission 未上屏')
  await typeLine('/compact 留重点')
  await sleep(120)
  if (kernel3.record.compactLine !== '/compact 留重点') problems.push(`phase3：/compact 未经 commands.execute：${kernel3.record.compactLine}`)
  kernel3.emit('compaction/start', { compactionId: 'c1', turn: null })
  await sleep(80)
  kernel3.emit('compaction/summary', {
    compactionId: 'c1',
    summary: [{ type: 'text', text: '摘要正文' }],
    shadowedRange: { start: 0, end: 1 },
    shadowedSeqs: [0, 1],
    shadowedTokenCount: 123,
    provider: 'p',
    model: 'm',
  })
  await sleep(80)
  kernel3.emit('compaction/end', { compactionId: 'c1', turn: null })
  await sleep(80)
  if (!visible3().includes('压缩完成')) problems.push('phase3：compaction 投影缺失')
  kernel3.emit('session/title', { title: '会话A', messageSeqs: [], source: { kind: 'user' } })
  await sleep(80)
  if (!visible3().includes('会话A')) problems.push('phase3：session/title 未上屏（页脚/标题）')
  kernel3.emit('hook/invoked', { turn: 1, point: 'PreToolUse', dialect: 'claude-code', handlerId: 'h1' })
  await sleep(60)
  kernel3.emit('hook/result', { turn: 1, point: 'PreToolUse', handlerId: 'h1', decision: 'allow', durationMs: 5 })
  await sleep(60)
  if (!visible3().includes('hook')) problems.push('phase3：hook 投影缺失')
  kernel3.emit('approval/asked', { id: 'a1', toolName: 'write', reason: '写文件' })
  await sleep(60)
  kernel3.emit('approval/decided', { id: 'a1', outcome: 'allowed-once' })
  await sleep(60)
  if (!visible3().includes('请求审批') || !visible3().includes('审批结果')) problems.push('phase3：approval 审计投影缺失')
  // /resume browser lists fake sessions with titles.
  for (const ch of '/resume') stdin3.text(ch)
  stdin3.key('return')
  await sleep(250)
  if (!visible3().includes('历史会话') || !visible3().includes('假标题A')) problems.push('phase3：/resume 浏览器未列出标题')
  stdin3.key('escape') // close the browser
  await sleep(100)
  // Rewind: two closed turns → double-Esc forks to the previous boundary.
  kernel3.emit('turn/start', { turn: 1 })
  await sleep(40)
  kernel3.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await sleep(40)
  kernel3.emit('turn/start', { turn: 2 })
  await sleep(40)
  kernel3.emit('turn/end', { turn: 2, reason: { kind: 'completed' } })
  await sleep(80)
  stdin3.key('escape')
  await sleep(40)
  stdin3.key('escape')
  await sleep(250)
  if (!kernel3.record.forkCalled) problems.push('phase3：双击 Esc 未触发回退 fork')
  if (!visible3().includes('已回退')) problems.push('phase3：回退确认缺失')
  // Welcome must wait for the connection: Session/Model rows carry real
  // values, never the `—`/`未设置` placeholders of a pre-connect render.
  if (!visible3().includes('✦ orca')) problems.push('phase3：欢迎卡缺失')
  if (visible3().includes('未设置')) problems.push('phase3：欢迎卡抢跑（连接前渲染）')
  dispose3()
  await sleep(20)

  // ── Phase 4: 欢迎卡延迟 + 服务懒探测 + / 命令菜单 ──────────────────────────
  const writes4: string[] = []
  const stdin4 = new FakeStdin()
  const kernel4 = new FakeKernel(true)
  kernel4.hideSessionQuery = true // registered "later" — eager capture would miss it forever
  const dispose4 = bootstrapApp(
    kernel4,
    { provider: '', model: '', fullscreen: false },
    { stdout: () => makeStdout(writes4), stdin: () => stdin4 },
  )
  await sleep(300)
  const visible4 = (): string => stripSgr(writes4.join(''))
  // Service registered after boot must still resolve (lazy probe, not
  // bootstrap-time capture).
  for (const ch of '/resume') stdin4.text(ch)
  stdin4.key('return')
  await sleep(120)
  if (!visible4().includes('sessionQuery 服务未挂载')) problems.push('phase4：缺失服务应明确提示')
  stdin4.key('escape') // clear the editor
  await sleep(80)
  kernel4.hideSessionQuery = false
  for (const ch of '/resume') stdin4.text(ch)
  stdin4.key('return')
  await sleep(250)
  if (!visible4().includes('历史会话')) problems.push('phase4：后注册的 sessionQuery 未被懒探测到')
  stdin4.key('escape')
  await sleep(100)
  // Inline menu: `/` lists commands without submitting.
  stdin4.text('/')
  await sleep(120)
  {
    const snap = paintScreen(writes4)
    if (!snap.some((row) => row.includes('/resume'))) problems.push('phase4：/ 菜单未列出 /resume')
    if (!snap.some((row) => row.includes('/help'))) problems.push('phase4：/ 菜单未列出 /help')
  }
  // ↓ + Tab completes the highlighted entry into the editor.
  stdin4.key('down')
  await sleep(80)
  stdin4.key('tab')
  await sleep(80)
  {
    const snap = paintScreen(writes4)
    if (!snap.some((row) => row.includes('> /model'))) problems.push('phase4：Tab 未补全高亮命令')
  }
  stdin4.key('escape') // clear editor
  await sleep(80)
  // Partial input + Enter completes first, dispatches on the second Enter.
  for (const ch of '/usa') stdin4.text(ch)
  await sleep(80)
  stdin4.key('return')
  await sleep(100)
  {
    const snap = paintScreen(writes4)
    if (!snap.some((row) => row.includes('> /usage'))) problems.push('phase4：Enter 未补全部分命令')
    if (visible4().includes('用量：')) problems.push('phase4：补全回车不应直接分发')
  }
  stdin4.key('return')
  await sleep(120)
  if (!visible4().includes('用量：')) problems.push('phase4：补全后回车未分发 /usage')
  dispose4()
  await sleep(20)

  // ── Phase 5: 同进程静默重挂载（热重载不再叠欢迎卡/建新会话）────────────────
  const writes5a: string[] = []
  const kernel5 = new FakeKernel(true)
  const dispose5a = bootstrapApp(
    kernel5,
    { provider: '', model: '', fullscreen: false },
    { stdout: () => makeStdout(writes5a), stdin: () => new FakeStdin() },
  )
  await sleep(300)
  const session5 = kernel5.record.createOptions?.sessionId
  if (!session5) problems.push('phase5：首次挂载未建会话')
  if (!stripSgr(writes5a.join('')).includes('✦ orca')) problems.push('phase5：首次挂载缺欢迎卡')
  dispose5a()
  await sleep(50)
  // Same process, same pid-file, previous agent disposed: the remount must
  // RESUME the session (no fresh create) with no welcome card, replaying the
  // durable log into the fresh channel.
  const createsBefore = kernel5.record.createCalls
  const writes5b: string[] = []
  const stdin5b = new FakeStdin()
  const dispose5b = bootstrapApp(
    kernel5,
    { provider: '', model: '', fullscreen: false },
    { stdout: () => makeStdout(writes5b), stdin: () => stdin5b },
  )
  await sleep(300)
  const visible5b = stripSgr(writes5b.join(''))
  if (kernel5.record.resumedId !== session5) problems.push(`phase5：重挂载未恢复同一会话：${kernel5.record.resumedId}`)
  if (kernel5.record.createCalls > createsBefore + 1) problems.push('phase5：重挂载建了多余会话')
  if (visible5b.includes('✦ orca')) problems.push('phase5：重挂载不应再刷欢迎卡')
  if (!visible5b.includes('hi 历史')) problems.push('phase5：持久化日志未重放进转录')
  dispose5b()
  await sleep(20)

  if (problems.length > 0) {
    console.error(`smoke 失败：${problems.join('；')}`)
    process.exit(1)
  }
  console.log(
    `smoke 通过 ✔（降级 + 真实契约闭环 + /model 热切换：${writes2.length} 次帧写入，${Buffer.byteLength(painted2)} 字节 ANSI）`,
  )
  process.exit(0)
}

await main()
