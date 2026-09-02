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
 *
 * Model selection mirrors the kernel's `installModelSelection` approach
 * without importing kernel packages: an `agent/request` waterfall listener
 * on the agent's own scope rewrites the resolved call config with the live
 * selection; `agentDefaultModel.saveSelection` persists it best-effort.
 */

import { randomUUID } from 'node:crypto'
import { Channel } from './adapter/channel.js'
import type { SessionRoute } from './adapter/channel.js'
import type { OrcaConfig } from './index.js'
import type { Agent, AgentHandle, KernelAgentDefaultModel, KernelAgentsService, KernelContext, KernelLlmService, KernelLoader, SessionEvent, UserMessage } from './kernel/types.js'
import { KERNEL_EVENTS } from './kernel/types.js'
import { buildFrame, routeKey, routeLine, welcomeCard } from './tui/chat.js'
import { classify, Keyboard } from './tui/input.js'
import type { KeyPress } from './tui/input.js'
import { openPicker, movePicker, pickedItem, type PickerItem, type PickerState } from './tui/picker.js'
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

type PickerStage =
  | { readonly kind: 'providers' }
  | { readonly kind: 'models'; readonly provider: string }
  | { readonly kind: 'effort'; readonly provider: string; readonly model: string }

export function bootstrapApp(ctx: KernelContext, config: OrcaConfig, deps: AppIoDeps = defaultDeps()): () => void {
  const stdout = deps.stdout()
  const stdin = deps.stdin()

  const channel = new Channel()
  const renderer = new Renderer(stdout, () => stdout.columns ?? 80)
  const agentFactory = ctx.get<KernelAgentsService>('agents', false)
  const llm = ctx.get<KernelLlmService>('llm', false)
  const defaultModel = ctx.get<KernelAgentDefaultModel>('agentDefaultModel', false)

  if (!agentFactory) {
    // #183 discipline: a missing kernel service must never break the boot.
    // With no factory there is no session to drive; surface one line and go.
    channel.pushSystem('kernel service `agents` 未挂载：Orca 以只读模式启动')
  }

  let handle: AgentHandle | null = null
  let agent: Agent | null = null
  let disposed = false

  /** Live model selection — overrides the request route via the waterfall. */
  let selection: SessionRoute | null = null
  let picker: PickerState | null = null
  let pickerStage: PickerStage | null = null
  const listenerDisposers: Array<() => void> = []

  // Kernel → channel: session events are the single source of truth. The
  // listener shape is (session, event); both arrive unknown-typed and are
  // parsed defensively by the channel.
  listenerDisposers.push(
    ctx.on(KERNEL_EVENTS.sessionEvent, (...args: unknown[]) => {
      const event = args[1] as Partial<SessionEvent> | undefined
      if (event && typeof event.type === 'string') channel.ingest(event as SessionEvent)
    }),
  )
  listenerDisposers.push(
    ctx.on(KERNEL_EVENTS.sessionDisposed, () => {
      channel.pushSystem('session 已释放')
      handle = null
      agent = null
    }),
  )
  // Model-turn failures surface outside the session log (`agent/error` is a
  // live dispatch, not a persisted event) — show them as local notices.
  listenerDisposers.push(
    ctx.on(KERNEL_EVENTS.agentError, (...args: unknown[]) => {
      const payload = recordOf(args[0])
      const failure = payload ? recordOf(payload['error']) : undefined
      const message = failure && typeof failure['message'] === 'string' ? failure['message'] : '未知错误'
      channel.pushSystem(`agent 出错：${message}`)
    }),
  )

  const submit = (text: string): void => {
    if (text === '/model') {
      openModelPicker()
      return
    }
    if (!agent) {
      channel.pushSystem('agent 未就绪，输入被丢弃')
      return
    }
    // No optimistic echo: the user row is projected from the kernel's
    // `user/message` event, so the transcript stays a pure log projection.
    agent.followup(buildUserMessage(text))
  }

  // ── /model picker ─────────────────────────────────────────────────────────

  const dbg = (message: string): void => {
    if (process.env['ORCA_DEBUG'] === '1') process.stderr.write(`[orca:dbg] ${message}\n`)
  }

  const closePicker = (): void => {
    picker = null
    pickerStage = null
  }

  const applySelection = (next: SessionRoute): void => {
    dbg(`applySelection ${next.provider}/${next.model}`)
    selection = next
    const effort = next.reasoningEffort ? `(${next.reasoningEffort})` : ''
    channel.pushSystem(`模型已切换：${next.provider}/${next.model}${effort} · 下一次请求生效`)
    if (defaultModel) {
      // Persist as the composition default, best-effort — the settings write
      // may reject OR throw synchronously (verified in-profile: a sync throw
      // rode the keypress handler and killed the process); neither may
      // break the switch.
      void Promise.resolve()
        .then(() => defaultModel.saveSelection({ ...next }))
        .then(() => dbg('saveSelection ok'))
        .catch((error) => dbg(`saveSelection failed: ${error instanceof Error ? error.message : String(error)}`))
    }
  }

  const pickFailed = (error: unknown): void => {
    closePicker()
    channel.pushSystem(`枚举模型失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const confirmPicker = (): void => {
    if (!picker || !pickerStage || !llm) {
      dbg(`confirmPicker skip: picker=${picker !== null} stage=${pickerStage?.kind ?? 'null'} llm=${llm !== undefined}`)
      return
    }
    const item = pickedItem(picker)
    dbg(`confirmPicker stage=${pickerStage.kind} item=${item?.value ?? '(none)'}${item?.disabled ? ' (disabled)' : ''}`)
    // Disabled rows (the loading placeholder) are not confirmable; an empty
    // value on the effort stage is a VALID choice — “默认（模型默认行为）”.
    if (!item || item.disabled) return

    if (pickerStage.kind === 'providers') {
      const provider = item.value
      const stage: PickerStage = { kind: 'models', provider }
      pickerStage = stage
      picker = openPicker(`选择模型（${provider}）`, loadingItems())
      void (async (): Promise<void> => {
        try {
          const models = await llm.listModels(provider)
          if (stage !== pickerStage) return // superseded by Esc/new open
          if (!models || models.length === 0) {
            channel.pushSystem(`${provider} 下没有可用模型`)
            closePicker()
            return
          }
          picker = openPicker(
            `选择模型（${provider}）`,
            models.map((m) => itemOf(m.name || m.id, m.id, m.description)),
          )
        } catch (error) {
          pickFailed(error)
        }
      })()
      return
    }

    if (pickerStage.kind === 'models') {
      const provider = pickerStage.provider
      const model = item.value
      const stage: PickerStage = { kind: 'effort', provider, model }
      pickerStage = stage
      picker = openPicker(`选择思考强度（${model}）`, loadingItems())
      void (async (): Promise<void> => {
        const items: PickerItem[] = [itemOf('默认（模型默认行为）', '')]
        try {
          const resolved = await llm.resolveModel(provider, model)
          for (const effort of resolved?.reasoning?.efforts ?? []) {
            items.push(itemOf(effort.name || effort.id, effort.id, effort.description))
          }
        } catch {
          // Exact-route resolution is optional; default-only stays usable.
        }
        if (stage !== pickerStage) return
        picker = openPicker(`选择思考强度（${model}）`, items)
      })()
      return
    }

    // Effort stage → final selection.
    const { provider, model } = pickerStage
    const reasoningEffort = item.value !== '' ? item.value : undefined
    applySelection(reasoningEffort ? { provider, model, reasoningEffort } : { provider, model })
    closePicker()
  }

  const handlePickerKey = (key: KeyPress): void => {
    if (!picker) return
    const action = classify(key)
    if (action === 'cancel') {
      closePicker()
      return
    }
    if (action === 'submit') {
      confirmPicker()
      return
    }
    if (action === 'navigate') {
      if (key.name === 'up') movePicker(picker, -1)
      else if (key.name === 'down') movePicker(picker, 1)
      return
    }
    if (action === 'text') {
      if (key.name === 'k') movePicker(picker, -1)
      else if (key.name === 'j') movePicker(picker, 1)
    }
  }

  const openModelPicker = (): void => {
    if (!llm) {
      channel.pushSystem('kernel service `llm` 未挂载：无法枚举模型')
      return
    }
    const stage: PickerStage = { kind: 'providers' }
    pickerStage = stage
    picker = openPicker('选择 Provider', loadingItems())
    void (async (): Promise<void> => {
      try {
        const providers = await Promise.resolve(llm.listProviders())
        if (stage !== pickerStage) return
        if (!providers || providers.length === 0) {
          channel.pushSystem('没有可用的 provider')
          closePicker()
          return
        }
        picker = openPicker(
          '选择 Provider',
          providers.map((p) => itemOf(p.name || p.id, p.id, p.name && p.name !== p.id ? p.id : undefined)),
        )
      } catch (error) {
        pickFailed(error)
      }
    })()
  }

  // ── agent lifecycle ───────────────────────────────────────────────────────

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
    const selection0 = defaultModel?.currentSelection()
    const selectionOptions =
      selection0 && selection0.provider !== '' && selection0.model !== ''
        ? { provider: selection0.provider, model: selection0.model }
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
    // Reflect the actual route in the header from the first frame — the
    // creation agentOptions ARE the route; the waterfall below re-asserts
    // the same values until /model changes them. Never overwrites a choice
    // the user already made while the connect retries were running.
    if (!selection) {
      const createdProvider = agent.options.provider
      const createdModel = agent.options.model
      if (createdProvider !== undefined && createdProvider !== '' && createdModel !== undefined && createdModel !== '') {
        selection = { provider: createdProvider, model: createdModel }
      }
    }
    // Route rewriter in the request waterfall — the same seam the kernel's
    // installModelSelection uses. Registered on the agent's own scope so it
    // dies with the agent; the returned disposer joins our cleanup chain.
    const disposeWaterfall = agent.ctx.on('agent/request', (...args: unknown[]) => {
      const next = args[1] as () => Promise<Record<string, unknown>>
      return (async (): Promise<Record<string, unknown>> => {
        const resolved = await next()
        const live = selection
        if (!live) return resolved
        const { reasoningEffort: _inherited, ...rest } = resolved
        return {
          ...rest,
          provider: live.provider,
          model: live.model,
          ...(live.reasoningEffort !== undefined ? { reasoningEffort: live.reasoningEffort } : {}),
        }
      })()
    })
    listenerDisposers.push(disposeWaterfall)
    channel.pushSystem(`session 已连接：${agent.session.id}`)
  }

  let editor = ''
  const keyboard = new Keyboard(stdin, (key) => {
    // The picker captures every key except the exit chord.
    if (picker && classify(key) !== 'exit') {
      handlePickerKey(key)
      return
    }
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
      case 'navigate':
      case 'ignore':
        break
    }
  })

  let flushedSealed = 0
  let welcomed = false
  let lastRouteKey = ''
  const render = (): void => {
    const route = selection ?? channel.route
    const stream: string[] = []
    // One-time welcome card; afterwards only route changes print a slim
    // line — the scrollback stream never accumulates repeated banners.
    if (!welcomed) {
      welcomed = true
      stream.push(...welcomeCard(process.cwd(), stdout.columns ?? 80))
      if (route) {
        stream.push(routeLine(route))
        lastRouteKey = routeKey(route)
      }
    } else if (route) {
      const key = routeKey(route)
      if (key !== lastRouteKey) {
        lastRouteKey = key
        stream.push(routeLine(route))
      }
    }
    const frame = buildFrame({
      channel,
      sealedFrom: flushedSealed,
      editorText: editor,
      width: stdout.columns ?? 80,
      cwd: process.cwd(),
      sessionId: agent?.session.id ?? null,
      route,
      usage: channel.usage,
      now: Date.now(),
      picker,
    })
    stream.push(...frame.stream)
    renderer.render(frame.live, stream, frame.cursor)
    flushedSealed = Math.min(channel.sealedRowCount, channel.rows.length)
  }

  // ~30fps render tick; the diff painter collapses no-op frames to zero
  // writes, so a fixed tick is cheap even while idle.
  const tick = setInterval(render, 33)
  // Own the screen: clear the viewport so orca starts from a clean slate
  // (shell residue stays in scrollback, one scroll away). In fullscreen
  // mode take the alternate buffer instead — the pre-orca screen is
  // restored verbatim on exit.
  stdout.write(config.fullscreen ? '\x1b[?1049h\x1b[2J\x1b[H' : '\x1b[2J\x1b[H')
  keyboard.start()
  void start()

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    clearInterval(tick)
    keyboard.stop()
    renderer.dispose()
    if (config.fullscreen) stdout.write('\x1b[?1049l')
    for (const disposeListener of listenerDisposers) disposeListener()
    void handle?.dispose()
  }

  return dispose
}

// ── helpers ──────────────────────────────────────────────────────────────────

function loadingItems(): PickerItem[] {
  return [{ value: '', label: '加载中…', disabled: true }]
}

function itemOf(label: string, value: string, hint?: string): PickerItem {
  return hint === undefined ? { value, label } : { value, label, hint }
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
