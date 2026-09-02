/**
 * App bootstrap: wire kernel seams ↔ channel ↔ renderer ↔ keyboard.
 *
 * Lifecycle contract: bootstrapApp returns a disposer; the plugin registers
 * it via ctx.effect so unmount restores the terminal, stops input, and
 * disposes the agent. Exit paths (Ctrl+C) run the same disposer.
 *
 * Agent driving follows the real `ctx.agents` contract (dsh-agent
 * v0.1.1-rc.2): `create/resume` return an owned `AgentHandle` whose `agent`
 * carries the prompt surface (`followup`/`steer` take full `UserMessage`
 * values), and the handle's `dispose` is the only teardown path.
 */

import { randomUUID } from 'node:crypto'
import { Channel } from './adapter/channel.js'
import type { OrcaConfig } from './index.js'
import type { Agent, AgentHandle, KernelAgentDefaultModel, KernelAgentsService, KernelContext, KernelLoader, SessionEvent, UserMessage } from './kernel/types.js'
import { KERNEL_EVENTS } from './kernel/types.js'
import { buildFrame } from './tui/chat.js'
import { classify, Keyboard } from './tui/input.js'
import { Renderer } from './tui/renderer.js'

export interface AppIoDeps {
  stdout(): NodeJS.WriteStream
  stdin(): NodeJS.ReadStream
}

/** How long start() keeps waiting for dsh-agent-loop to register its factory. */
const FACTORY_RETRY_ATTEMPTS = 50
const FACTORY_RETRY_DELAY_MS = 100

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export function bootstrapApp(ctx: KernelContext, config: OrcaConfig, deps: AppIoDeps = defaultDeps()): () => void {
  const stdout = deps.stdout()
  const stdin = deps.stdin()

  const channel = new Channel()
  const renderer = new Renderer(stdout, () => stdout.columns ?? 80)
  const agentFactory = ctx.get<KernelAgentsService>('agents', false)

  if (!agentFactory) {
    // #183 discipline: a missing kernel service must never break the boot.
    // With no factory there is no session to drive; surface one line and go.
    channel.pushSystem('kernel service `agents` 未挂载：Orca 以只读模式启动')
  }

  let handle: AgentHandle | null = null
  let agent: Agent | null = null
  let disposed = false

  // Kernel → channel: session events are the single source of truth. The
  // listener shape is (session, event); both arrive unknown-typed and are
  // parsed defensively by the channel.
  ctx.on(KERNEL_EVENTS.sessionEvent, (...args: unknown[]) => {
    const event = args[1] as Partial<SessionEvent> | undefined
    if (event && typeof event.type === 'string') channel.ingest(event as SessionEvent)
  })
  ctx.on(KERNEL_EVENTS.sessionDisposed, () => {
    channel.pushSystem('session 已释放')
    handle = null
    agent = null
  })
  // Model-turn failures surface outside the session log (`agent/error` is a
  // live dispatch, not a persisted event) — show them as local notices.
  ctx.on(KERNEL_EVENTS.agentError, (...args: unknown[]) => {
    const payload = recordOf(args[0])
    const failure = payload ? recordOf(payload['error']) : undefined
    const message = failure && typeof failure['message'] === 'string' ? failure['message'] : '未知错误'
    channel.pushSystem(`agent 出错：${message}`)
  })

  const submit = (text: string): void => {
    if (!agent) {
      channel.pushSystem('agent 未就绪，输入被丢弃')
      return
    }
    // No optimistic echo: the user row is projected from the kernel's
    // `user/message` event, so the transcript stays a pure log projection.
    agent.followup(buildUserMessage(text))
  }

  const start = async (): Promise<void> => {
    if (!agentFactory) return
    const cwd = process.cwd()
    const resumeId = process.env['ORCA_RESUME_SESSION']
    // Loader entries activate concurrently, so the factory and the default
    // model service may not exist yet when apply() runs. Await full plugin
    // activation first — the canonical pattern (dsh-headless) — and keep the
    // targeted factory retry below as a safety net.
    const loader = ctx.get<KernelLoader>('loader', false)
    await loader?.await()
    // The kernel applies NO default model on its own: read the composition's
    // default (`agentDefaultModel`) and pass provider+model through
    // agentOptions, or every turn fails with "has no provider/model".
    // provider+model set together in the config override the default.
    const defaultModel = ctx.get<KernelAgentDefaultModel>('agentDefaultModel', false)
    const selection = defaultModel?.currentSelection()
    const selectionOptions =
      selection && selection.provider !== '' && selection.model !== ''
        ? { provider: selection.provider, model: selection.model }
        : undefined
    const agentOptions =
      config.provider !== '' && config.model !== ''
        ? { provider: config.provider, model: config.model }
        : selectionOptions
    const createOptions = agentOptions
      ? { sessionId: mintSessionId(), meta: { cwd }, agentOptions }
      : { sessionId: mintSessionId(), meta: { cwd } }
    // Boot-time race (verified in-profile, dsh 0.1.1-rc.2): loader entries
    // activate concurrently, so the `agents` registry can exist before
    // dsh-agent-loop registers the creation factory on it — the first
    // create/resume rejects with "no agent factory registered". Retry that
    // specific pending-factory error briefly; anything else is terminal.
    for (let attempt = 0; ; attempt++) {
      try {
        handle = resumeId
          ? await agentFactory.resume(agentOptions ? { resumeSessionId: resumeId, agentOptions } : { resumeSessionId: resumeId })
          : await agentFactory.create(createOptions)
        break
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (attempt < FACTORY_RETRY_ATTEMPTS && /no agent factory registered/i.test(message)) {
          await sleep(FACTORY_RETRY_DELAY_MS)
          continue
        }
        channel.pushSystem(`agent 启动失败：${message}`)
        return
      }
    }
    agent = handle.agent
    channel.pushSystem(`session 已连接：${agent.session.id}`)
  }

  let editor = ''
  const keyboard = new Keyboard(stdin, (key) => {
    switch (classify(key)) {
      case 'exit': {
        dispose()
        process.exit(0)
        break
      }
      case 'cancel': {
        if (editor) editor = ''
        else agent?.cancel({ kind: 'user' })
        break
      }
      case 'submit': {
        const text = editor.trim()
        editor = ''
        if (text) submit(text)
        break
      }
      case 'backspace': {
        editor = editor.slice(0, editor.length - 1)
        break
      }
      case 'text': {
        editor += key.sequence
        break
      }
      case 'ignore':
        break
    }
  })

  const render = (): void => {
    renderer.render(
      buildFrame({
        channel,
        editorText: editor,
        width: stdout.columns ?? 80,
        cwd: process.cwd(),
        sessionId: agent?.session.id ?? null,
      }),
    )
  }

  // ~30fps render tick; the diff painter collapses no-op frames to zero
  // writes, so a fixed tick is cheap even while idle.
  const tick = setInterval(render, 33)
  keyboard.start()
  void start()

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    clearInterval(tick)
    keyboard.stop()
    renderer.dispose()
    void handle?.dispose()
  }

  return dispose
}

/** The kernel brands `session-<uuid>` strings as SessionId — compile-time only. */
function mintSessionId(): string {
  return `session-${randomUUID()}`
}

/**
 * Build the `UserMessage` the kernel's `followup`/`steer` expect: identified
 * content blocks plus the supplying source. Plain structural object — the
 * kernel validates lossless JSON at the append boundary, brands are
 * compile-time only.
 */
function buildUserMessage(text: string): UserMessage {
  return {
    id: `msg-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function defaultDeps(): AppIoDeps {
  return {
    stdout: () => process.stdout,
    stdin: () => process.stdin,
  }
}
