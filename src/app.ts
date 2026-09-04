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
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Channel } from './adapter/channel.js'
import type { SessionRoute } from './adapter/channel.js'
import type { OrcaConfig } from './index.js'
import type {
  Agent,
  AgentHandle,
  KernelAgentDefaultModel,
  KernelAgentsService,
  KernelApprovalPolicy,
  KernelApprovalService,
  KernelCommandsService,
  KernelContext,
  KernelLlmService,
  KernelLoader,
  KernelSessionQueryService,
  KernelSessionTitleService,
  KernelSessionsService,
  SessionEvent,
  UserMessage,
} from './kernel/types.js'
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

/** In-process mount counter — attributes ORCA_LOG lines to one bootstrap. */
let bootSeq = 0

type PickerStage =
  | { readonly kind: 'providers' }
  | { readonly kind: 'models'; readonly provider: string }
  | { readonly kind: 'effort'; readonly provider: string; readonly model: string }
  | { readonly kind: 'sessions' }
  | { readonly kind: 'approval' }

/** Slash command metadata — kimi-style grouping, aliases, idle gating. */
interface SlashCommand {
  readonly name: string
  readonly aliases: readonly string[]
  readonly group: string
  readonly description: string
  /** When true the command refuses while a turn is running (needs idle). */
  readonly idleOnly?: boolean
}

const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'help', aliases: ['h', '?'], group: '信息', description: '显示命令帮助' },
  { name: 'model', aliases: [], group: '账号/配置', description: '切换模型（provider → 模型 → 思考强度）' },
  { name: 'new', aliases: ['clear'], group: '会话', description: '丢弃当前上下文，开新会话' },
  { name: 'resume', aliases: ['sessions'], group: '会话', description: '浏览并恢复历史会话' },
  { name: 'title', aliases: ['rename'], group: '会话', description: '查看或设置会话标题' },
  { name: 'compact', aliases: [], group: '会话', description: '压缩上下文（可附 hint）', idleOnly: true },
  { name: 'usage', aliases: [], group: '信息', description: '显示 token 用量明细' },
  { name: 'yolo', aliases: [], group: '模式', description: '审批全放行开关（on/off）' },
  { name: 'permission', aliases: [], group: '模式', description: '查看当前审批策略' },
]

function findSlash(name: string): SlashCommand | undefined {
  const lower = name.toLowerCase()
  return SLASH_COMMANDS.find((cmd) => cmd.name === lower || cmd.aliases.includes(lower))
}

function parseSlash(text: string): { readonly name: string; readonly args: string } | undefined {
  if (!text.startsWith('/')) return undefined
  const space = text.indexOf(' ')
  if (space === -1) return { name: text.slice(1), args: '' }
  return { name: text.slice(1, space), args: text.slice(space + 1).trim() }
}

export function bootstrapApp(ctx: KernelContext, config: OrcaConfig, deps: AppIoDeps = defaultDeps()): () => void {
  const stdout = deps.stdout()
  const stdin = deps.stdin()
  const bootId = ++bootSeq

  // Byte-level forensics (opt-in): ORCA_LOG=<path> records every stdout
  // write with its terminal geometry. Used to diagnose viewport artifacts
  // (truncation/misalignment) against the exact byte stream. Never affects
  // rendering; failures are swallowed so logging can never break the TUI.
  const logPath = process.env['ORCA_LOG']
  if (logPath) {
    try {
      appendFileSync(
        logPath,
        `\n### boot#${bootId} pid=${process.pid} cols=${String(stdout.columns)} rows=${String(stdout.rows)} at=${new Date().toISOString()}\n`,
      )
      const origWrite = stdout.write.bind(stdout) as (...args: unknown[]) => boolean
      let writeNo = 0
      stdout.write = ((...args: unknown[]): boolean => {
        try {
          const head = args[0]
          const body = typeof head === 'string' ? head : '<non-string chunk>'
          appendFileSync(
            logPath,
            `--- boot#${bootId} write#${writeNo++} cols=${String(stdout.columns)} rows=${String(stdout.rows)} bytes=${Buffer.byteLength(body)} ---\n${body}\n`,
          )
        } catch {
          // Logging must never break the TUI.
        }
        return origWrite(...args)
      }) as typeof stdout.write
    } catch {
      // Logging must never break the TUI.
    }
  }

  const channel = new Channel()
  const renderer = new Renderer(
    stdout,
    () => stdout.columns ?? 80,
    () => stdout.rows ?? 24,
  )
  // Optional seams are soft-probed LAZILY at each use site (#183): loader
  // entries activate concurrently, so a service captured once at bootstrap
  // may stay `undefined` forever even though the kernel registers it moments
  // later (verified: `sessionQuery` read "unmounted" in-profile). Probing
  // through these getters after `loader.await()` (or on user action) always
  // sees the live registry.
  const getAgents = (): KernelAgentsService | undefined => ctx.get<KernelAgentsService>('agents', false)
  const getLlm = (): KernelLlmService | undefined => ctx.get<KernelLlmService>('llm', false)
  const getDefaultModel = (): KernelAgentDefaultModel | undefined => ctx.get<KernelAgentDefaultModel>('agentDefaultModel', false)
  const getSessionQuery = (): KernelSessionQueryService | undefined => ctx.get<KernelSessionQueryService>('sessionQuery', false)
  const getSessionTitle = (): KernelSessionTitleService | undefined => ctx.get<KernelSessionTitleService>('sessionTitle', false)
  const getCommands = (): KernelCommandsService | undefined => ctx.get<KernelCommandsService>('commands', false)
  const getApproval = (): KernelApprovalService | undefined => ctx.get<KernelApprovalService>('approval', false)
  const getSessions = (): KernelSessionsService | undefined => ctx.get<KernelSessionsService>('sessions', false)

  let handle: AgentHandle | null = null
  let agent: Agent | null = null
  let disposed = false
  /**
   * Effective approval policy folded from the log (`ask` default,
   * `never` = headless auto-reject). Yolo (auto-allow) is NOT a policy —
   * the kernel has no allow-all policy; Orca implements it as an
   * auto-answering `approval/request` waterfall (see below).
   */
  let approvalPolicy: KernelApprovalPolicy = 'ask'
  /** Yolo mode: auto-answer every approval ask with `allowed-once`. */
  let yoloMode = false

  /** Live model selection — overrides the request route via the waterfall. */
  let selection: SessionRoute | null = null
  let picker: PickerState | null = null
  let pickerStage: PickerStage | null = null
  const listenerDisposers: Array<() => void> = []

  // ── approval panel (M4) ───────────────────────────────────────────────────
  // One-shot FIFO: the kernel may ask concurrently (parallel tools); Orca
  // shows the head and queues the rest. Each entry resolves its waterfall
  // exactly once — dispose/cancel resolves `cancelled`, yolo `allowed-once`.

  interface PendingApproval {
    readonly toolName: string
    readonly reason: string
    resolve: (outcome: 'allowed-once' | 'rejected' | 'cancelled') => void
    settled: boolean
  }

  const approvalQueue: PendingApproval[] = []

  const showApprovalPanel = (): void => {
    const head = approvalQueue[0]
    if (!head) return
    // Approval is modal: it supersedes any picker (the model picker can be
    // reopened with /model after the decision).
    pickerStage = { kind: 'approval' }
    picker = openPicker(
      `审批：${head.toolName}${head.reason ? ` — ${head.reason}` : ''}`,
      [
        { value: 'allowed-once', label: '放行单次', hint: '1' },
        { value: 'rejected', label: '拒绝', hint: '2/Esc' },
      ],
    )
  }

  const settleApprovalHead = (outcome: 'allowed-once' | 'rejected' | 'cancelled'): void => {
    const head = approvalQueue.shift()
    if (!head || head.settled) {
      if (pickerStage?.kind === 'approval') closePicker()
      return
    }
    head.settled = true
    if (pickerStage?.kind === 'approval') closePicker()
    head.resolve(outcome)
    // Show the next queued ask, if any.
    if (approvalQueue.length > 0) showApprovalPanel()
  }

  const answerApproval = (
    toolName: string,
    reason: string,
    signal: AbortSignal | undefined,
  ): Promise<'allowed-once' | 'rejected' | 'cancelled'> => {
    // Yolo: auto-allow without ever showing the panel.
    if (yoloMode) return Promise.resolve('allowed-once')
    if (disposed) return Promise.resolve('cancelled')
    return new Promise<'allowed-once' | 'rejected' | 'cancelled'>((resolve) => {
      const entry: PendingApproval = {
        toolName: toolName === '' ? 'tool' : toolName,
        reason,
        resolve,
        settled: false,
      }
      approvalQueue.push(entry)
      if (approvalQueue.length === 1) showApprovalPanel()
      signal?.addEventListener(
        'abort',
        () => {
          const index = approvalQueue.indexOf(entry)
          if (index !== -1) approvalQueue.splice(index, 1)
          if (!entry.settled) {
            entry.settled = true
            if (pickerStage?.kind === 'approval' && approvalQueue.length === 0) closePicker()
            else if (pickerStage?.kind === 'approval') showApprovalPanel()
            resolve('cancelled')
          }
        },
        { once: true },
      )
    })
  }

  // Kernel → channel: session events are the single source of truth. The
  // listener shape is (session, event); both arrive unknown-typed and are
  // parsed defensively by the channel.
  listenerDisposers.push(
    ctx.on(KERNEL_EVENTS.sessionEvent, (...args: unknown[]) => {
      const event = args[1] as Partial<SessionEvent> | undefined
      if (event && typeof event.type === 'string') {
        channel.ingest(event as SessionEvent)
        // Fold the durable approval override for the footer — the log is
        // truth; the local /yolo switch below only updates the same fold.
        if (event.type === 'approval/policy' && agent) {
          try {
            const next = getApproval()?.overrideOf(agent.session)
            if (next) approvalPolicy = next
          } catch {
            // Best-effort fold; the footer keeps its last known value.
          }
        }
      }
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
    const slash = parseSlash(text.trim())
    if (slash) {
      const cmd = findSlash(slash.name)
      if (cmd) {
        // Idle-gated commands refuse while a turn runs (kimi "Always
        // available" column) — the user breaks with Esc first.
        if (cmd.idleOnly && channel.runState !== 'idle') {
          channel.pushSystem(`/${cmd.name} 需在空闲时执行，先按 Esc 打断当前回合`)
          return
        }
        dispatchSlash(cmd.name, slash.args)
        return
      }
      // Unknown slash: try the kernel-owned registry (e.g. future commands
      // registered by plugins). Admission misses resolve to undefined and
      // fall through to a normal prompt — the kimi behavior.
      const registry = agent ? getCommands() : undefined
      if (agent && registry) {
        const line = text.trim()
        void (async (): Promise<void> => {
          try {
            const execution = await registry.execute(agent, line, [], new AbortController().signal)
            if (execution === undefined) {
              agent.followup(buildUserMessage(text))
            }
          } catch (error) {
            channel.pushSystem(`命令执行失败：${error instanceof Error ? error.message : String(error)}`)
          }
        })()
        return
      }
      // No registry to ask — treat as a normal prompt (kimi fallback).
    }
    if (!agent) {
      channel.pushSystem('agent 未就绪，输入被丢弃')
      return
    }
    // No optimistic echo: the user row is projected from the kernel's
    // `user/message` event, so the transcript stays a pure log projection.
    agent.followup(buildUserMessage(text))
  }

  const dispatchSlash = (name: string, args: string): void => {
    switch (name) {
      case 'help':
        showHelp()
        break
      case 'model':
        openModelPicker()
        break
      case 'usage':
        showUsage()
        break
      case 'title':
        doTitle(args)
        break
      case 'new':
        void switchToNew()
        break
      case 'resume':
        openResumePicker()
        break
      case 'compact':
        void doCompact(args)
        break
      case 'yolo':
        doYolo(args)
        break
      case 'permission':
        showPermission()
        break
      default:
        channel.pushSystem(`未知命令：/${name}（/help 查看）`)
        break
    }
  }

  const showHelp = (): void => {
    const groups = new Map<string, string[]>()
    for (const cmd of SLASH_COMMANDS) {
      const aliases = cmd.aliases.length > 0 ? `（别名 /${cmd.aliases.join('、/')}）` : ''
      const line = `/${cmd.name}${aliases} — ${cmd.description}`
      const list = groups.get(cmd.group) ?? []
      list.push(line)
      groups.set(cmd.group, list)
    }
    // Kernel-registered commands (e.g. /compact's owner) append after ours.
    const registry = agent ? getCommands() : undefined
    if (agent && registry) {
      try {
        const extra = registry
          .list(agent)
          .filter((descriptor) => findSlash(descriptor.name) === undefined)
          .map((descriptor) => `/${descriptor.name} — ${descriptor.description}`)
        if (extra.length > 0) groups.set('内核', extra)
      } catch {
        // Discovery is best-effort; local help stays usable.
      }
    }
    channel.pushSystem('可用命令：')
    for (const [group, lines] of groups) {
      channel.pushSystem(`【${group}】${lines.join(' · ')}`)
    }
    channel.pushSystem('快捷键：Ctrl+O 展开思考过程 · 双击 Esc 回退上一轮 · 未知 /命令将作为普通消息发给模型')
  }

  const showUsage = (): void => {
    const usage = channel.usage
    channel.pushSystem(
      `用量：↑${usage.input} 输入 · ↓${usage.output} 输出${usage.reasoning > 0 ? ` · ✻${usage.reasoning} 推理` : ''} · ${usage.messages} 条 assistant 消息`,
    )
  }

  const showPermission = (): void => {
    const approval = getApproval()
    if (agent && approval) {
      try {
        const override = approval.overrideOf(agent.session)
        const effective = override ?? approvalPolicy
        channel.pushSystem(`审批策略：${effective}${yoloMode ? ' · yolo 开（自动放行单次）' : ''}（ask = 逐次确认，never = 全拒绝）`)
        return
      } catch {
        // Fall through to the cached value.
      }
    }
    channel.pushSystem(`审批策略：${approvalPolicy}${yoloMode ? ' · yolo 开' : ''}（approval 服务未挂载时为本地估计值）`)
  }

  const doYolo = (args: string): void => {
    const normalized = args.trim().toLowerCase()
    let next: boolean | null = null
    if (normalized === 'on' || normalized === 'true' || normalized === '1') next = true
    else if (normalized === 'off' || normalized === 'false' || normalized === '0') next = false
    else if (normalized === '') next = !yoloMode
    if (next === null) {
      channel.pushSystem('用法：/yolo [on|off]')
      return
    }
    yoloMode = next
    // Yolo needs asks to reach our answerer: force the session policy back
    // to `ask` when enabling (a `never` policy would auto-reject before we
    // ever see the request). Best-effort; local flag still drives the panel.
    const approval = getApproval()
    if (next && agent && approval) {
      try {
        approval.setPolicy(agent, 'ask')
        approvalPolicy = 'ask'
      } catch {
        // Local flag stands on its own.
      }
    }
    channel.pushSystem(next ? 'yolo 已开启：工具审批自动放行（单次授权）' : 'yolo 已关闭：恢复逐次确认')
  }

  const doTitle = (args: string): void => {
    if (!agent) {
      channel.pushSystem('agent 未就绪，标题不可用')
      return
    }
    if (args === '') {
      // Show: prefer the folded log title, fall back to the service.
      const current = channel.title ?? safeTitleGet()
      channel.pushSystem(current ? `会话标题：${current}` : '会话暂无标题（首条用户消息后自动生成）')
      return
    }
    const sessionTitle = getSessionTitle()
    if (!sessionTitle) {
      channel.pushSystem('sessionTitle 服务未挂载：无法设置标题')
      return
    }
    try {
      const snapshot = sessionTitle.rename(agent.session, args)
      channel.pushSystem(`标题已更新：${snapshot.title}`)
    } catch (error) {
      channel.pushSystem(`设置标题失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const safeTitleGet = (): string | null => {
    const sessionTitle = getSessionTitle()
    if (!agent || !sessionTitle) return null
    try {
      return sessionTitle.get(agent.session)?.title ?? null
    } catch {
      return null
    }
  }

  const doCompact = async (hint: string): Promise<void> => {
    if (!agent) {
      channel.pushSystem('agent 未就绪，无法压缩')
      return
    }
    const commands = getCommands()
    if (!commands) {
      channel.pushSystem('commands 服务未挂载：无法执行 /compact（内核需挂载 dsh-command-compact）')
      return
    }
    const line = hint === '' ? '/compact' : `/compact ${hint}`
    try {
      const execution = await commands.execute(agent, line, [], new AbortController().signal)
      if (execution === undefined) {
        channel.pushSystem('内核未注册 /compact 命令')
      }
      // Success/failure rows arrive via command/done + compaction/* events.
    } catch (error) {
      channel.pushSystem(`压缩失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const switchToNew = async (): Promise<void> => {
    const agentFactory = getAgents()
    if (!agentFactory) {
      channel.pushSystem('agents 服务未挂载：无法新建会话')
      return
    }
    const previous = handle
    handle = null
    agent = null
    try {
      await previous?.dispose()
    } catch {
      // Teardown failures must not block the fresh session.
    }
    channel.clearForSwitch()
    welcomeRows = null
    slimRows = []
    welcomed = true // suppress the one-time welcome on switches
    await createAgent()
  }

  const createAgent = async (resumeId?: string): Promise<void> => {
    const agentFactory = getAgents()
    if (!agentFactory) {
      channel.pushSystem('kernel service `agents` 未挂载：Orca 以只读模式启动')
      return
    }
    const cwd = process.cwd()
    const agentOptions = currentAgentOptions()
    const createOptions = agentOptions
      ? { sessionId: mintSessionId(), meta: { cwd }, agentOptions }
      : { sessionId: mintSessionId(), meta: { cwd } }
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
    attachAgent(handle.agent)
    channel.pushSystem(`session 已连接：${handle.agent.session.id}`)
    // Remember the live session for a same-process silent remount (hot
    // reload): the next bootstrap resumes THIS session instead of minting a
    // new one, so rebuilds stop stacking welcomes on the screen.
    writeLastSession(handle.agent.session.id)
  }

  /**
   * Same-process silent remount (hot reload path). When the previous mount
   * in THIS process owned `lastSessionId` and its agent is gone (its effect
   * disposer ran `handle.dispose()`), resume it from persistence and replay
   * the durable log into the fresh channel: no new session, no welcome card,
   * no route line — the rebuild is invisible. Any failure falls through to
   * the normal fresh-create path. An explicit ORCA_RESUME_SESSION always
   * wins and bypasses this.
   */
  const trySilentRemount = async (): Promise<boolean> => {
    const agentFactory = getAgents()
    if (!agentFactory) return false
    const last = readLastSession()
    if (!last || last.pid !== process.pid) return false
    // Still live = still owned by its mount (its effect never unwound).
    // Adopting foreign ownership would race its disposal — stay out.
    try {
      if (agentFactory.get(last.sessionId)) return false
    } catch {
      return false
    }
    const agentOptions = currentAgentOptions()
    try {
      handle = await agentFactory.resume(
        agentOptions ? { resumeSessionId: last.sessionId, agentOptions } : { resumeSessionId: last.sessionId },
      )
    } catch {
      return false
    }
    attachAgent(handle.agent)
    welcomed = true // suppress the one-time welcome AND route line on remount
    try {
      const snapshot = await getSessionQuery()?.readSession(last.sessionId)
      const events = snapshot?.events
      if (events && events.length > 0) {
        channel.replay(events)
        channel.sealedRowCount = channel.rows.length
      }
    } catch {
      // Empty transcript — live events are the truth from here on.
    }
    writeLastSession(handle.agent.session.id)
    return true
  }

  const currentAgentOptions = (): { provider: string; model: string } | undefined => {
    const defaultModel = getDefaultModel()
    const selection0 = defaultModel?.currentSelection()
    const selectionOptions =
      selection0 && selection0.provider !== '' && selection0.model !== '' ? { provider: selection0.provider, model: selection0.model } : undefined
    if (config.provider !== '' && config.model !== '') return { provider: config.provider, model: config.model }
    return selectionOptions
  }

  const attachAgent = (next: Agent): void => {
    agent = next
    if (!selection) {
      const createdProvider = next.options.provider
      const createdModel = next.options.model
      if (createdProvider !== undefined && createdProvider !== '' && createdModel !== undefined && createdModel !== '') {
        selection = { provider: createdProvider, model: createdModel }
      }
    }
    try {
      const override = getApproval()?.overrideOf(next.session)
      if (override) approvalPolicy = override
    } catch {
      // Keep last known policy.
    }
    const disposeWaterfall = next.ctx.on('agent/request', (...args: unknown[]) => {
      const waterfallNext = args[1] as () => Promise<Record<string, unknown>>
      return (async (): Promise<Record<string, unknown>> => {
        const resolved = await waterfallNext()
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
    // Interactive answerer for `approval/request` (dsh-user-approval
    // waterfall, scoped to this agent — dies with the agent). Yolo
    // short-circuits inside answerApproval; the audit pair still lands via
    // session/event. A throwing answerer must never break the turn — the
    // service normalizes it to `unavailable`, but we fail closed to
    // `rejected` ourselves so the panel can never grant by accident.
    const disposeApproval = next.ctx.on(KERNEL_EVENTS.approvalRequest, (...args: unknown[]) => {
      const req = recordOf(args[0])
      const waterfallNext = typeof args[1] === 'function' ? (args[1] as () => Promise<string>) : undefined
      return (async (): Promise<string> => {
        let toolName = ''
        let reason = ''
        let signal: AbortSignal | undefined
        if (req) {
          if (typeof req['toolName'] === 'string') toolName = req['toolName']
          if (typeof req['reason'] === 'string') reason = req['reason']
          if (req['signal'] instanceof AbortSignal) signal = req['signal']
        }
        try {
          return await answerApproval(toolName, reason, signal)
        } catch {
          return 'rejected'
        } finally {
          // Keep the chain honest: if we did not claim the ask (e.g. yolo
          // short-circuit still counts as a claim — we returned), nothing to
          // delegate. We always claim, so `next` is never called.
          void waterfallNext
        }
      })()
    })
    listenerDisposers.push(disposeApproval)
  }

  // ── /model picker ─────────────────────────────────────────────────────────

  const dbg = (message: string): void => {
    if (process.env['ORCA_DEBUG'] === '1') process.stderr.write(`[orca:dbg] ${message}\n`)
  }

  const closePicker = (): void => {
    picker = null
    pickerStage = null
  }

  // ── inline slash-command menu (kimi `/` completion) ───────────────────────
  // Non-modal: derived from the editor text every frame, navigated with ↑↓
  // (wrap-around), completed with Tab (or Enter on a partial match),
  // dismissed by Esc (which clears the editor as before).

  let menuIndex = 0

  const menuMatches = (editorText: string): PickerItem[] => {
    if (!editorText.startsWith('/') || editorText.includes(' ')) return []
    const prefix = editorText.slice(1).toLowerCase()
    return SLASH_COMMANDS.filter(
      (cmd) => cmd.name.startsWith(prefix) || cmd.aliases.some((alias) => alias.startsWith(prefix)),
    ).map((cmd) => itemOf(`/${cmd.name}`, cmd.name, cmd.description))
  }

  const currentMenu = (): { readonly items: readonly PickerItem[]; readonly index: number } | null => {
    if (picker) return null
    const items = menuMatches(editor)
    if (items.length === 0) return null
    return { items, index: Math.max(0, Math.min(items.length - 1, menuIndex)) }
  }

  const completeMenu = (): boolean => {
    const menu = currentMenu()
    if (!menu || menu.items.length === 0) return false
    const item = menu.items[menu.index]
    if (!item) return false
    editor = `/${item.value}`
    menuIndex = 0
    return true
  }

  const applySelection = (next: SessionRoute): void => {
    dbg(`applySelection ${next.provider}/${next.model}`)
    selection = next
    const effort = next.reasoningEffort ? `(${next.reasoningEffort})` : ''
    channel.pushSystem(`模型已切换：${next.provider}/${next.model}${effort} · 下一次请求生效`)
    const defaultModel = getDefaultModel()
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
    if (!picker || !pickerStage) {
      dbg(`confirmPicker skip: picker=${picker !== null} stage=${pickerStage?.kind ?? 'null'}`)
      return
    }
    if (pickerStage.kind === 'sessions') {
      confirmResumePicker()
      return
    }
    if (pickerStage.kind === 'approval') {
      const item = pickedItem(picker)
      if (!item || item.disabled) return
      settleApprovalHead(item.value === 'allowed-once' ? 'allowed-once' : 'rejected')
      return
    }
    const llm = getLlm()
    if (!llm) {
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
      picker = openPicker(`选择模型（${provider}）`, loadingItems(), selection?.model)
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
            selection?.model,
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
      picker = openPicker(`选择思考强度（${model}）`, loadingItems(), selection?.reasoningEffort)
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
        picker = openPicker(`选择思考强度（${model}）`, items, selection?.reasoningEffort)
      })()
      return
    }

    // Effort stage → final selection.
    if (pickerStage.kind !== 'effort') return
    const { provider, model } = pickerStage
    const reasoningEffort = item.value !== '' ? item.value : undefined
    applySelection(reasoningEffort ? { provider, model, reasoningEffort } : { provider, model })
    closePicker()
  }

  const handlePickerKey = (key: KeyPress): void => {
    if (!picker) return
    // Approval shortcuts (kimi 1/2/3): answer without moving the cursor.
    if (pickerStage?.kind === 'approval' && classify(key) === 'text') {
      if (key.sequence === '1') {
        settleApprovalHead('allowed-once')
        return
      }
      if (key.sequence === '2') {
        settleApprovalHead('rejected')
        return
      }
    }
    const action = classify(key)
    if (action === 'cancel') {
      // Esc on the approval panel is an explicit reject (kimi behavior);
      // on other pickers it just closes.
      if (pickerStage?.kind === 'approval') {
        settleApprovalHead('rejected')
        return
      }
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
    const llm = getLlm()
    if (!llm) {
      channel.pushSystem('kernel service `llm` 未挂载：无法枚举模型')
      return
    }
    const stage: PickerStage = { kind: 'providers' }
    pickerStage = stage
    picker = openPicker('选择 Provider', loadingItems(), selection?.provider)
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
          selection?.provider,
        )
      } catch (error) {
        pickFailed(error)
      }
    })()
  }

  // ── /resume browser (placeholder: full picker lands next) ──────────────────

  const openResumePicker = (): void => {
    const sessionQuery = getSessionQuery()
    if (!sessionQuery) {
      channel.pushSystem('sessionQuery 服务未挂载：无法浏览历史会话（内核需挂载 dsh-session-query）')
      return
    }
    if (!getAgents()) {
      channel.pushSystem('agents 服务未挂载：无法恢复会话')
      return
    }
    const stage: PickerStage = { kind: 'sessions' }
    pickerStage = stage
    picker = openPicker('历史会话', loadingItems())
    void (async (): Promise<void> => {
      try {
        const records = await sessionQuery.listSessions()
        if (stage !== pickerStage) return
        if (records.length === 0) {
          channel.pushSystem('没有可恢复的历史会话')
          closePicker()
          return
        }
        const ids = records.slice(0, 50).map((record) => record.header.id)
        let titles = new Map<string, string>()
        try {
          const snapshots = await sessionQuery.readTitleSnapshots(ids)
          for (const result of snapshots) {
            if (result.status === 'fulfilled' && result.value.title) {
              titles.set(result.sessionId, result.value.title.title)
            }
          }
        } catch {
          // Titles are best-effort; the browser still lists ids/cwd/time.
        }
        const items = records.slice(0, 50).map((record) => {
          const title = titles.get(record.header.id) ?? shortSessionLabel(record.header.id)
          const cwd = record.header.cwd ? ` · ${shortPath(record.header.cwd)}` : ''
          const when = formatTime(record.header.createdAt)
          return itemOf(`${title}${cwd}`, record.header.id, when)
        })
        picker = openPicker('历史会话（Enter 恢复 · Esc 取消）', items, agent?.session.id)
      } catch (error) {
        if (stage !== pickerStage) return
        closePicker()
        channel.pushSystem(`枚举会话失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }

  const confirmResumePicker = (): void => {
    if (!picker || pickerStage?.kind !== 'sessions') return
    const item = pickedItem(picker)
    if (!item || item.disabled) return
    const resumeId = item.value
    closePicker()
    if (!resumeId || (agent && resumeId === agent.session.id)) {
      channel.pushSystem('已是当前会话')
      return
    }
    void switchToResume(resumeId)
  }

  const switchToResume = async (resumeId: string): Promise<void> => {
    if (!getAgents()) return
    const previous = handle
    handle = null
    agent = null
    try {
      await previous?.dispose()
    } catch {
      // Teardown failures must not block the resumed session.
    }
    channel.clearForSwitch()
    welcomeRows = null
    slimRows = []
    welcomed = true
    await createAgent(resumeId)
    // Best-effort: replay the persisted log so the transcript is not empty
    // before live events arrive. Failures stay silent — live events are truth.
    try {
      const snapshot = await getSessionQuery()?.readTitle(resumeId)
      if (snapshot) channel.title = snapshot.title
    } catch {
      // Ignored.
    }
  }

  // ── rewind: double-Esc forks to the previous turn boundary (M3) ────────────
  // pi `/tree` + kimi `/undo` spirit, kernel-native via `ctx.sessions.fork`:
  // the child keeps the prefix through the previous turn, later turns stay in
  // the parent log on disk. Idle-only; needs ≥2 observed turns.

  const doRewind = async (): Promise<void> => {
    const agentFactory = getAgents()
    if (!agent || !handle || !agentFactory) {
      channel.pushSystem('agent 未就绪，无法回退')
      return
    }
    const sessions = getSessions()
    if (!sessions) {
      channel.pushSystem('sessions 服务未挂载：无法回退（内核需挂载 dsh-session）')
      return
    }
    if (channel.runState !== 'idle') {
      channel.pushSystem('回合运行中，先按 Esc 打断再双击 Esc 回退')
      return
    }
    const turns = channel.turnSeqs
    if (turns.length < 2) {
      channel.pushSystem('没有可回退的回合（至少需要两轮对话）')
      return
    }
    const boundary = turns[turns.length - 2]
    if (boundary === undefined) {
      channel.pushSystem('没有可回退的回合')
      return
    }
    const childId = mintSessionId()
    let child: { id: string } | null = null
    try {
      child = sessions.fork(agent.session, boundary, childId) as unknown as { id: string }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/OPEN_TURN/i.test(message)) {
        channel.pushSystem('回退失败：边界落在未闭合回合内，稍后重试')
      } else {
        channel.pushSystem(`回退失败：${message}`)
      }
      return
    }
    const childSessionId = typeof child?.id === 'string' ? child.id : childId
    const previous = handle
    handle = null
    agent = null
    try {
      await previous?.dispose()
    } catch {
      // Teardown failures must not block the rewound session.
    }
    channel.clearForSwitch()
    welcomeRows = null
    slimRows = []
    welcomed = true
    await createAgent(childSessionId)
    channel.pushSystem(`已回退到上一轮（fork ${shortSessionLabel(childSessionId)}）`)
  }

  // M4 status slot: git branch, cached 2s (file read only, no spawn).
  let branchCache: { readonly at: number; readonly cwd: string; readonly value: string | null } | null = null

  const gitBranch = (cwd: string): string | null => {
    const now = Date.now()
    if (branchCache && branchCache.cwd === cwd && now - branchCache.at < 2000) return branchCache.value
    let value: string | null = null
    try {
      const head = readFileSync(join(cwd, '.git', 'HEAD'), 'utf8').trim()
      const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
      value = match?.[1] ?? null
    } catch {
      value = null
    }
    branchCache = { at: now, cwd, value }
    return value
  }

  // Title for the footer: channel.title (event fold) wins; the service is a
  // 1s-cached fallback so the 30fps render never folds the log per tick.
  let titleCache: { readonly at: number; readonly value: string | null } | null = null

  const safeTitleGetCached = (): string | null => {
    const now = Date.now()
    if (titleCache && now - titleCache.at < 1000) return titleCache.value
    const value = safeTitleGet()
    titleCache = { at: now, value }
    return value
  }

  // ── agent lifecycle ───────────────────────────────────────────────────────

  const start = async (): Promise<void> => {
    const resumeId = process.env['ORCA_RESUME_SESSION']
    // Loader entries activate concurrently, so the factory and the default
    // model service may not exist yet when apply() runs. Await full plugin
    // activation first — the canonical pattern (dsh-headless) — and keep the
    // targeted factory retry in createAgent as a safety net.
    const loader = ctx.get<KernelLoader>('loader', false)
    await loader?.await()
    if (!resumeId && (await trySilentRemount())) return
    await createAgent(resumeId)
  }

  let editor = ''
  let lastEscAt = 0
  // Chrome 恒钉底——render 内 `anchorChrome` 恒为 true（M6 的 picker 闩锁已退役，
  // 不再有"浮动→钉底"跳变需要闩）。
  /** Ctrl+O: full thinking text instead of the short live preview (kimi expand). */
  let thoughtExpanded = false
  const keyboard = new Keyboard(stdin, (key) => {
    // Thinking expand/collapse is a pure view toggle — works everywhere,
    // including while a picker or the approval panel is on screen.
    if (key.ctrl && key.name === 'o') {
      thoughtExpanded = !thoughtExpanded
      return
    }
    // The picker captures every key except the exit chord.
    if (picker && classify(key) !== 'exit') {
      handlePickerKey(key)
      return
    }
    // Tab completes the inline slash menu (no-op without one).
    if (key.name === 'tab' && !picker) {
      completeMenu()
      return
    }
    // ↑↓ cycle the inline slash menu while it is visible; otherwise they
    // stay no-ops (never smear CSI sequences into the prompt).
    if ((key.name === 'up' || key.name === 'down') && !picker) {
      const menu = currentMenu()
      if (menu && menu.items.length > 1) {
        const delta = key.name === 'down' ? 1 : -1
        menuIndex = (menu.index + delta + menu.items.length) % menu.items.length
        return
      }
    }
    switch (classify(key)) {
      case 'exit': {
        dispose()
        process.exit(0)
        break
      }
      case 'cancel': {
        if (editor) {
          editor = ''
          menuIndex = 0
          break
        }
        if (picker) {
          // Approval Esc is handled inside handlePickerKey (explicit
          // reject); other pickers just close here.
          handlePickerKey(key)
          break
        }
        // Double-Esc on an empty idle editor = rewind to the previous turn
        // (pi /tree + kimi /undo spirit). Single Esc still cancels the turn.
        const now = Date.now()
        const doubleEsc = now - lastEscAt < 600
        lastEscAt = now
        if (doubleEsc && channel.runState === 'idle') {
          void doRewind()
        } else {
          agent?.cancel({ kind: 'user' })
        }
        break
      }
      case 'submit': {
        const text = editor.trim()
        // Partial slash input completes from the menu first (kimi behavior);
        // a second Enter dispatches the completed command.
        if (text.startsWith('/') && !text.includes(' ') && !picker) {
          const slash = parseSlash(text)
          if (slash && !findSlash(slash.name)) {
            if (completeMenu()) break
          }
        }
        editor = ''
        menuIndex = 0
        if (text) submit(text)
        break
      }
      case 'backspace': {
        editor = editor.slice(0, editor.length - 1)
        menuIndex = 0
        break
      }
      case 'text': {
        editor += key.sequence
        menuIndex = 0
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
  // Live-pinned notices (welcome card + route slim lines): built once at
  // connect, rendered at the live top until overfill-scroll ages them off
  // gradually. See the render-block comment for why flips are forbidden.
  let welcomeRows: string[] | null = null
  let slimRows: string[] = []
  const render = (): void => {
    const fullscreen = config.fullscreen === true
    // 总是钉底：inline/fullscreen 一律 spacer 撑满视口，输入框从首帧起固定在终端底边。
    const anchorChrome = true
    const route = selection ?? channel.route
    const cwd = process.cwd()
    const title = channel.title ?? safeTitleGetCached()
    const stream: string[] = []
    // One-time notices — deferred until the agent connects so the
    // Session/Model rows carry real values instead of `—`/`未设置`.
    // Inline pins them at the live top for the whole session (built once,
    // cleared only on session switch): the transcript keeps its full
    // budget, and any overflow overfill-scrolls — the top ages gradually
    // instead of vanishing in one jump. Flipping a never-live stream row
    // kills it in a single tick (the vanished-welcome regression), so
    // notices are never flipped. Afterwards only route changes append slim
    // lines (capped at 3 — the footer always shows the live route).
    // Fullscreen has no native scrollback, so its notices go through the
    // channel and render inside the transcript window instead.
    if (!welcomed) {
      if (agent) {
        welcomed = true
        const routeModel = route ? `${route.provider}/${route.model}${route.reasoningEffort ? `(${route.reasoningEffort})` : ''}` : null
        if (fullscreen) {
          channel.pushSystem(`✦ orca 已连接 · session ${shortSessionLabel(agent.session.id)}`)
        } else {
          welcomeRows = [...welcomeCard(process.cwd(), agent.session.id, routeModel, stdout.columns ?? 80)]
        }
        if (route) {
          const line = routeLine(route)
          if (fullscreen) channel.pushSystem(line)
          else slimRows = [...slimRows, line].slice(-3)
          lastRouteKey = routeKey(route)
        }
      }
    } else if (route) {
      const key = routeKey(route)
      if (key !== lastRouteKey) {
        lastRouteKey = key
        const line = routeLine(route)
        if (fullscreen) channel.pushSystem(line)
        else slimRows = [...slimRows, line].slice(-3)
      }
    }
    const notices = fullscreen ? null : [...(welcomeRows ?? []), ...slimRows]
    const menu = currentMenu()
    let frame = buildFrame({
      channel,
      sealedFrom: flushedSealed,
      editorText: editor,
      width: stdout.columns ?? 80,
      height: stdout.rows ?? 24,
      // Include rows about to be written into scrollback in this frame's
      // budget. Otherwise the first welcome frame (or a route-change line)
      // plus a full-height padded live frame would scroll the terminal.
      // Only rows written by THIS render occupy space above the live frame.
      // Historical welcome/route rows are already in scrollback and must not
      // permanently reduce the chat viewport.
      reservedRows: stream.length,
      anchorChrome,
      notices,
      fullscreen,
      cwd,
      sessionId: agent?.session.id ?? null,
      route,
      usage: channel.usage,
      now: Date.now(),
      picker,
      commandMenu: menu,
      thoughtExpanded,
      connecting: agent === null,
      title,
      policy: approvalPolicy,
      yolo: yoloMode,
      branch: gitBranch(cwd),
    })
    // Sealed transcript rows are discovered while building the frame; fold
    // their stream height into a second pass so bottom chrome remains fixed
    // even when a turn ends while a picker is open.
    if (frame.stream.length > 0) {
      frame = buildFrame({
        channel,
        sealedFrom: flushedSealed,
        editorText: editor,
        width: stdout.columns ?? 80,
        height: stdout.rows ?? 24,
        reservedRows: stream.length + frame.stream.length,
        anchorChrome,
        notices,
      fullscreen,
        cwd,
        sessionId: agent?.session.id ?? null,
        route,
        usage: channel.usage,
        now: Date.now(),
        picker,
        commandMenu: menu,
        thoughtExpanded,
        connecting: agent === null,
        title,
        policy: approvalPolicy,
        yolo: yoloMode,
        branch: gitBranch(cwd),
      })
    }
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
    // Unblock any pending approval asks — late answers are discarded by the
    // service once the signal fires, but our promise must still settle.
    while (approvalQueue.length > 0) settleApprovalHead('cancelled')
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

function shortSessionLabel(id: string): string {
  return id.length > 18 ? '..' + id.slice(-12) : id
}

function shortPath(cwd: string): string {
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
  const display = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
  return display.replaceAll('\\', '/')
}

function formatTime(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return ''
  const date = new Date(epochMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Override point for tests — the harness sandboxes this to a temp file. */
function lastSessionFile(): string {
  const override = process.env['ORCA_LAST_SESSION_FILE']
  if (override) return override
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
  return join(home, '.dsh', 'orca-last-session.json')
}

interface LastSessionRecord {
  readonly pid: number
  readonly sessionId: string
}

/** Best-effort read of the last live session marker (null on any failure). */
function readLastSession(): LastSessionRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lastSessionFile(), 'utf8'))
    const record = recordOf(parsed)
    const pid = record?.['pid']
    const sessionId = record?.['sessionId']
    if (typeof pid === 'number' && Number.isInteger(pid) && typeof sessionId === 'string' && sessionId !== '') {
      return { pid, sessionId }
    }
    return null
  } catch {
    return null
  }
}

/** Best-effort write of the last live session marker (never throws). */
function writeLastSession(sessionId: string): void {
  try {
    writeFileSync(lastSessionFile(), JSON.stringify({ pid: process.pid, sessionId }))
  } catch {
    // Marker loss only costs a silent remount, never the session.
  }
}

function defaultDeps(): AppIoDeps {
  return {
    stdout: () => process.stdout,
    stdin: () => process.stdin,
  }
}
