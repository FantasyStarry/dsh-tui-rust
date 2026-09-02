/**
 * App bootstrap: wire kernel seams ↔ channel ↔ renderer ↔ keyboard.
 *
 * Lifecycle contract: bootstrapApp returns a disposer; the plugin registers
 * it via ctx.effect so unmount restores the terminal, stops input, and
 * disposes the agent. Exit paths (Ctrl+C) run the same disposer.
 */

import { Channel } from './adapter/channel.js'
import type { OrcaConfig } from './index.js'
import type { KernelAgentHandle, KernelAgentsService, KernelContext, SessionEvent } from './kernel/types.js'
import { KERNEL_EVENTS } from './kernel/types.js'
import { buildFrame } from './tui/chat.js'
import { classify, Keyboard } from './tui/input.js'
import { Renderer } from './tui/renderer.js'

export interface AppIoDeps {
  stdout(): NodeJS.WriteStream
  stdin(): NodeJS.ReadStream
}

export function bootstrapApp(ctx: KernelContext, _config: OrcaConfig, deps: AppIoDeps = defaultDeps()): () => void {
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

  let agent: KernelAgentHandle | null = null
  let disposed = false

  // Kernel → channel: session events are the single source of truth. The
  // event listener shape is (sessionRef, event); both arrive unknown-typed
  // and are parsed defensively by the channel.
  ctx.on(KERNEL_EVENTS.sessionEvent, (...args: unknown[]) => {
    const event = args[1] as Partial<SessionEvent> | undefined
    if (event && typeof event.type === 'string') channel.ingest(event as SessionEvent)
  })
  ctx.on(KERNEL_EVENTS.sessionDisposed, () => {
    channel.pushSystem('session 已释放')
    agent = null
  })

  const submit = (text: string): void => {
    if (!agent) {
      channel.pushSystem('agent 未就绪，输入被丢弃')
      return
    }
    channel.pushUser(text)
    void agent.followup(text)
  }

  const start = async (): Promise<void> => {
    if (!agentFactory) return
    const cwd = process.cwd()
    const resumeId = process.env['ORCA_RESUME_SESSION']
    try {
      agent = resumeId
        ? await agentFactory.resume(resumeId, { cwd })
        : await agentFactory.create({ cwd })
      channel.pushSystem(`session 已连接：${agent.session.id}`)
    } catch (error) {
      channel.pushSystem(`agent 启动失败：${error instanceof Error ? error.message : String(error)}`)
    }
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
        else agent?.cancel()
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
    void agent?.dispose()
  }

  return dispose
}

function defaultDeps(): AppIoDeps {
  return {
    stdout: () => process.stdout,
    stdin: () => process.stdin,
  }
}
