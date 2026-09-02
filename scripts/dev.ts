/**
 * Headless smoke harness: `pnpm dev` boots the real bootstrap path against a
 * fake kernel. Two phases, both through the same `session/event` seam the
 * kernel uses:
 *
 *   Phase 1 — degraded boot (#183): `agents` unmounted → one system row,
 *             never a throw.
 *   Phase 2 — mounted fake kernel implementing the REAL dsh-agent contract
 *             (v0.1.1-rc.2): `create({sessionId, meta, agentOptions})` →
 *             `AgentHandle{agent, dispose}`; a scripted turn streams the REAL
 *             session envelope (`{type, seq, time, data}`, `assistant/chunk`
 *             carrying `StreamChunk` text/reasoning deltas) driven by real
 *             keyboard keypresses through the editor → `followup(UserMessage)`
 *             → projection → diff-painted frames.
 *
 * Exits non-zero on failure — CI-usable. A real-TTY run is still required
 * for keyboard/rendering feel; this harness only proves plumbing.
 */

import { EventEmitter } from 'node:events'
import { bootstrapApp } from '../src/app.js'
import { Config } from '../src/index.js'
import type { OrcaConfig } from '../src/index.js'
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

function makeStdout(writes: string[]): NodeJS.WriteStream {
  return {
    columns: 100,
    write(chunk: string): boolean {
      writes.push(chunk)
      return true
    },
  } as unknown as NodeJS.WriteStream
}

/** Fake TTY stdin: keypress events are emitted directly by the harness. */
class FakeStdin extends EventEmitter {
  isTTY = true
  setRawMode(mode: boolean): boolean {
    return mode
  }
  resume(): void {}
  pause(): void {}

  /** A named key (return / escape / c with ctrl …). */
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
  disposed: boolean
}

/**
 * Fake kernel context. `mounted` decides whether the `agents` service exists;
 * when mounted, the service implements the REAL dsh-agent create/resume
 * contract and the fake agent streams a scripted turn through the real
 * session-event envelope.
 */
class FakeKernel implements KernelContext {
  readonly record: KernelRecord = { createOptions: null, followupMessage: null, cancelCause: null, disposed: false }
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private seq = 0

  constructor(private readonly mounted: boolean) {}

  on(name: string, listener: (...args: unknown[]) => void): void {
    const set = this.listeners.get(name) ?? new Set()
    set.add(listener)
    this.listeners.set(name, set)
  }

  get<T = unknown>(name: string, _soft?: false): T | undefined {
    if (!this.mounted) return undefined
    if (name === 'agents') return this.agentsService as T
    if (name === 'loader') return { await: async (): Promise<void> => {} } as T
    if (name === 'agentDefaultModel') {
      return { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) } as T
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

  private factoryCalls = 0

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
   * (`{type, seq, time, data}`), `assistant/chunk` carrying `StreamChunk`
   * values — real deltas, not the committed-block-at-turn-end the old ACP
   * wire protocol forced on us. Staggered so the diff painter exercises
   * multiple frames.
   */
  private streamTurn(message: UserMessage): void {
    const turn = 1
    const step = 1
    const at = (delay: number, type: string, data: unknown): void => {
      setTimeout(() => this.emit(type, data), delay)
    }
    at(0, 'turn/start', { turn })
    at(10, 'user/message', message)
    at(40, 'assistant/chunk', { turn, step, chunk: { type: 'text-delta', index: 0, text: '你好，Orca。' } })
    at(120, 'assistant/chunk', { turn, step, chunk: { type: 'text-delta', index: 0, text: '流式增量上屏测试。' } })
    at(160, 'assistant/chunk', { turn, step, chunk: { type: 'reasoning-delta', index: 1, text: '思考一下。' } })
    at(200, 'tool/call', { turn, step, callId: 'call-1', name: 'read', arguments: '{"path":"src/app.ts"}' })
    at(260, 'tool/result', {
      turn,
      step,
      message: {
        id: 'msg-result-1',
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: 'call-1' },
      },
    })
    at(300, 'turn/end', { turn, reason: { kind: 'completed' } })
  }
}

async function main(): Promise<void> {
  const problems: string[] = []

  // ── Phase 0: the Config Standard Schema contract ──────────────────────────
  // cordis resolveConfig calls Config['~standard'].validate before starting
  // the plugin; a plain defaults table failed the real profile boot
  // (`Cannot read properties of undefined (reading 'validate')`).
  const schema = Config['~standard']
  const valueOf = (result: { value?: unknown }): OrcaConfig | undefined =>
    typeof result.value === 'object' && result.value !== null ? (result.value as OrcaConfig) : undefined
  const filled = valueOf(schema.validate({ provider: 'p1', fullscreen: 'yes' as unknown as boolean }))
  if (schema.version !== 1 || filled?.provider !== 'p1' || filled.fullscreen !== false) {
    problems.push('phase0：Config 校验未按 Standard Schema 收敛')
  }
  const empty = valueOf(schema.validate(undefined))
  if (empty?.provider !== '' || empty.fullscreen !== false) {
    problems.push('phase0：Config 缺省校验失败')
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
  if (writes1.length === 0) problems.push('phase1：没有帧写入')
  if (!painted1.includes('agents` 未挂载')) problems.push('phase1：降级启动提示缺失')

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
  await sleep(550) // the scripted turn streams through
  dispose2()
  await sleep(20) // handle.dispose() settles

  const painted2 = writes2.join('')
  const record = kernel2.record
  if (writes2.length === 0) problems.push('phase2：没有帧写入')
  if (painted2.includes('agent 启动失败')) problems.push('phase2：工厂未就绪竞态未被重试吸收')
  if (!painted2.includes('session 已连接')) problems.push('phase2：session 连接提示缺失')
  if (!painted2.includes('帮我看看')) problems.push('phase2：user/message 未投影（session 非真源）')
  if (!painted2.includes('你好，Orca。')) problems.push('phase2：assistant 流式转录缺失')
  if (!painted2.includes('流式增量上屏测试。')) problems.push('phase2：增量 chunk 未并入同一行')
  if (!painted2.includes('思考一下。')) problems.push('phase2：reasoning-delta 未进思考行')
  if (!painted2.includes('[✔] read')) problems.push('phase2：工具行未落到成功态')
  if (!painted2.includes('就绪')) problems.push('phase2：turn/end 后状态未回就绪')
  if (record.createOptions === null || !/^session-/.test(record.createOptions.sessionId)) {
    problems.push('phase2：create 未收到规范的 sessionId')
  }
  if (record.createOptions?.meta?.cwd !== process.cwd()) problems.push('phase2：create 未携带 cwd')
  if (record.createOptions?.agentOptions?.provider !== 'default-provider') problems.push('phase2：agentOptions.provider 未取组合默认路由')
  if (record.createOptions?.agentOptions?.model !== 'default-model') problems.push('phase2：agentOptions.model 未取组合默认模型')
  const firstBlock = record.followupMessage?.content[0]
  if (firstBlock?.type !== 'text' || firstBlock.text !== '帮我看看') {
    problems.push('phase2：followup 未收到规范 UserMessage 文本块')
  }
  if (record.followupMessage?.source['kind'] !== 'user') problems.push('phase2：followup 消息缺 user 来源')
  if (record.cancelCause?.kind !== 'user') problems.push('phase2：cancel 未携带 user 原因')
  if (!record.disposed) problems.push('phase2：dispose 未触达 handle.dispose')

  if (problems.length > 0) {
    console.error(`smoke 失败：${problems.join('；')}`)
    process.exit(1)
  }
  console.log(
    `smoke 通过 ✔（降级启动 + 真实契约闭环：${writes2.length} 次帧写入，${Buffer.byteLength(painted2)} 字节 ANSI）`,
  )
  process.exit(0)
}

await main()
