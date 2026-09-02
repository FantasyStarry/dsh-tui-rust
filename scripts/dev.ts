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
import { bootstrapApp } from '../src/app.js'
import { Config } from '../src/index.js'
import type { OrcaConfig } from '../src/index.js'
import { Renderer } from '../src/tui/renderer.js'
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

/** Fake TTY stdin: keypress events are emitted directly by the harness. */
class FakeStdin extends EventEmitter {
  isTTY = true
  setRawMode(mode: boolean): boolean {
    return mode
  }
  resume(): void {}
  pause(): void {}

  /** A named key (return / escape / up / down …). */
  key(name: string, opts: { ctrl?: boolean; sequence?: string } = {}): void {
    this.emit('keypress', '', {
      name,
      ctrl: opts.ctrl ?? false,
      alt: false,
      shift: false,
      sequence: opts.sequence ?? name,
    })
  }

  /** A plain text key (printable sequence, CJK included). */
  text(sequence: string): void {
    this.emit('keypress', sequence, { name: sequence, ctrl: false, alt: false, shift: false, sequence })
  }
}

interface KernelRecord {
  createOptions: CreateAgentOptions | null
  followupMessage: UserMessage | null
  cancelCause: { kind: string } | null
  selectionSaved: { provider: string; model: string; reasoningEffort?: string } | null
  requestListener: ((...args: unknown[]) => unknown) | null
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
    followupMessage: null,
    cancelCause: null,
    selectionSaved: null,
    requestListener: null,
    disposed: false,
  }
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private seq = 0
  private factoryCalls = 0

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
      return {
        agent,
        dispose: async (): Promise<void> => {
          kernel.record.disposed = true
        },
      }
    },
    resume: async (options: ResumeAgentOptions): Promise<AgentHandle> => {
      return this.agentsService.create({ sessionId: options.resumeSessionId, agentOptions: options.agentOptions })
    },
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
    if (countOf('> 说点什么…') !== 1) problems.push('phase2：编辑后输入行重复/缺失')
    if (countOf('Enter 发送') !== 1) problems.push('phase2：编辑后提示行重复/缺失')
    if (snap.some((row) => row.includes('思考中…'))) problems.push('phase2：idle 页脚不应显示思考中徽标')
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
  const hint = 'Enter 发送  ·  /model 模型  ·  Esc 取消  ·  Ctrl+C 退出'
  if (tail.length !== 5) problems.push(`phase2：最终画面尾部不足 5 行：${JSON.stringify(rows2.slice(-7))}`)
  const promptRow = rows2.find((row) => row.includes('> 说点什么…'))
  if (promptRow === undefined) {
    problems.push(`phase2：输入行不完整：${JSON.stringify(rows2.slice(-8))}`)
  }
  if (!rows2.some((row) => row.includes(hint))) problems.push(`phase2：提示行缺失或不唯一：${JSON.stringify(tail)}`)
  // The q1 submit opened the second turn — the footer badge is mid-turn here.
  const footerRow = rows2.find((row) => row.includes('思考中…'))
  if (footerRow === undefined) problems.push(`phase2：页脚缺失或状态不符：${JSON.stringify(tail)}`)
  // The /model switch happened before q1 — the footer must show the LIVE selection.
  if (footerRow === undefined || !footerRow.includes('fake-a/fake-a-m1(low)')) problems.push(`phase2：页脚未反映切换后路由：${JSON.stringify(footerRow)}`)

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
