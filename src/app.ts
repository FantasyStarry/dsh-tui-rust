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

type PickerStage =
  | { readonly kind: 'providers' }
  | { readonly kind: 'models'; readonly provider: string }
  | { readonly kind: 'effort'; readonly provider: string; readonly model: string }
  | { readonly kind: 'sessions' }

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

  const channel = new Channel()
  const renderer = new Renderer(stdout, () => stdout.columns ?? 80)
  const agentFactory = ctx.get<KernelAgentsService>('agents', false)
  const llm = ctx.get<KernelLlmService>('llm', false)
  const defaultModel = ctx.get<KernelAgentDefaultModel>('agentDefaultModel', false)
  // M3/M4 optional seams — all soft-probed, all degrade silently (#183).
  const sessionQuery = ctx.get<KernelSessionQueryService>('sessionQuery', false)
  const sessionTitle = ctx.get<KernelSessionTitleService>('sessionTitle', false)
  const commands = ctx.get<KernelCommandsService>('commands', false)
  const approval = ctx.get<KernelApprovalService>('approval', false)
  const sessions = ctx.get<KernelSessionsService>('sessions', false)

  if (!agentFactory) {
    // #183 discipline: a missing kernel service must never break the boot.
    // With no factory there is no session to drive; surface one line and go.
    channel.pushSystem('kernel service `agents` 未挂载：Orca 以只读模式启动')
  }

  let handle: AgentHandle | null = null
  let agent: Agent | null = null
  let disposed = false
  /** Effective approval policy for the footer (`ask` default, `never` = yolo). */
  let approvalPolicy: KernelApprovalPolicy = 'ask'

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
      if (event && typeof event.type === 'string') {
        channel.ingest(event as SessionEvent)
        // Fold the durable approval override for the footer — the log is
        // truth; the local /yolo switch below only updates the same fold.
        if (event.type === 'approval/policy' && agent) {
          try {
            const next = approval?.overrideOf(agent.session)
            if (next) approvalPolicy = next
          } catch {
            // Best-effort fold; the footer keeps its last known value.
          }
        }
        // Fold the live title for the footer when the service is absent.
        if (event.type === 'session/title' && sessionTitle === undefined && agent) {
          try {
            const snapshot = undefined
            void snapshot
          } catch {
            // Ignored — channel.title already updated by ingest.
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
      if (agent && commands) {
        const line = text.trim()
        void (async (): Promise<void> => {
          try {
            const execution = await commands.execute(agent, line, [], new AbortController().signal)
            if (execution === undefined) {
              conversationStarted = true
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
    conversationStarted = true
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
    if (agent && commands) {
      try {
        const extra = commands
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
    channel.pushSystem('未知 /命令将作为普通消息发给模型')
  }

  const showUsage = (): void => {
    const usage = channel.usage
    channel.pushSystem(
      `用量：↑${usage.input} 输入 · ↓${usage.output} 输出${usage.reasoning > 0 ? ` · ✻${usage.reasoning} 推理` : ''} · ${usage.messages} 条 assistant 消息`,
    )
  }

  const showPermission = (): void => {
    if (agent && approval) {
      try {
        const override = approval.overrideOf(agent.session)
        channel.pushSystem(`审批策略：${override ?? approvalPolicy}（ask = 逐次确认，never = 全放行/yolo）`)
        return
      } catch {
        // Fall through to the cached value.
      }
    }
    channel.pushSystem(`审批策略：${approvalPolicy}（approval 服务未挂载时为本地估计值）`)
  }

  const doYolo = (args: string): void => {
    const normalized = args.trim().toLowerCase()
    let next: KernelApprovalPolicy | null = null
    if (normalized === 'on' || normalized === 'true' || normalized === '1') next = 'never'
    else if (normalized === 'off' || normalized === 'false' || normalized === '0') next = 'ask'
    else if (normalized === '') next = approvalPolicy === 'ask' ? 'never' : 'ask'
    if (!next) {
      channel.pushSystem('用法：/yolo [on|off]')
      return
    }
    if (!agent || !approval) {
      // No seam to persist — keep a local estimate so the footer still
      // reflects intent; the next session fold corrects it.
      approvalPolicy = next
      channel.pushSystem(`approval 服务未挂载：本地切换为 ${next}（仅显示）`)
      return
    }
    try {
      approval.setPolicy(agent, next)
      approvalPolicy = next
      channel.pushSystem(next === 'never' ? 'yolo 已开启：审批全放行（never）' : 'yolo 已关闭：恢复逐次确认（ask）')
    } catch (error) {
      channel.pushSystem(`切换审批策略失败：${error instanceof Error ? error.message : String(error)}`)
    }
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
    conversationStarted = false
    welcomed = true // suppress the one-time welcome on switches
    await createAgent()
  }

  const createAgent = async (resumeId?: string): Promise<void> => {
    if (!agentFactory) return
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
  }

  const currentAgentOptions = (): { provider: string; model: string } | undefined => {
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
      const override = approval?.overrideOf(next.session)
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
    if (!picker || !pickerStage) {
      dbg(`confirmPicker skip: picker=${picker !== null} stage=${pickerStage?.kind ?? 'null'} llm=${llm !== undefined}`)
      return
    }
    if (pickerStage.kind === 'sessions') {
      confirmResumePicker()
      return
    }
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
    if (!sessionQuery) {
      channel.pushSystem('sessionQuery 服务未挂载：无法浏览历史会话（内核需挂载 dsh-session-query）')
      return
    }
    if (!agentFactory) {
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
    if (!agentFactory) return
    const previous = handle
    handle = null
    agent = null
    try {
      await previous?.dispose()
    } catch {
      // Teardown failures must not block the resumed session.
    }
    channel.clearForSwitch()
    conversationStarted = false
    welcomed = true
    await createAgent(resumeId)
    // Best-effort: replay the persisted log so the transcript is not empty
    // before live events arrive. Failures stay silent — live events are truth.
    try {
      const snapshot = await sessionQuery?.readTitle(resumeId)
      if (snapshot) channel.title = snapshot.title
    } catch {
      // Ignored.
    }
  }

  // ── agent lifecycle ───────────────────────────────────────────────────────

  const start = async (): Promise<void> => {
    if (!agentFactory) return
    const resumeId = process.env['ORCA_RESUME_SESSION']
    // Loader entries activate concurrently, so the factory and the default
    // model service may not exist yet when apply() runs. Await full plugin
    // activation first — the canonical pattern (dsh-headless) — and keep the
    // targeted factory retry in createAgent as a safety net.
    const loader = ctx.get<KernelLoader>('loader', false)
    await loader?.await()
    await createAgent(resumeId)
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
  let conversationStarted = false
  const render = (): void => {
    const route = selection ?? channel.route
    const stream: string[] = []
    // One-time welcome card; afterwards only route changes print a slim
    // line — the scrollback stream never accumulates repeated banners.
    if (!welcomed) {
      welcomed = true
      const routeModel = route ? `${route.provider}/${route.model}${route.reasoningEffort ? `(${route.reasoningEffort})` : ''}` : null
      stream.push(...welcomeCard(process.cwd(), agent?.session.id ?? null, routeModel, stdout.columns ?? 80))
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
      anchorChrome: conversationStarted || picker !== null,
      cwd: process.cwd(),
      sessionId: agent?.session.id ?? null,
      route,
      usage: channel.usage,
      now: Date.now(),
      picker,
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
        anchorChrome: conversationStarted || picker !== null,
        cwd: process.cwd(),
        sessionId: agent?.session.id ?? null,
        route,
        usage: channel.usage,
        now: Date.now(),
        picker,
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
  return id.length > 18 ? '…' + id.slice(-12) : id
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

function defaultDeps(): AppIoDeps {
  return {
    stdout: () => process.stdout,
    stdin: () => process.stdin,
  }
}
