/**
 * Headless smoke harness: `pnpm dev` boots the real bootstrap path against a
 * fake kernel — fake stdout collects frames, no raw-mode stdin, canned
 * session events stream through the same `session/event` seam the kernel
 * uses. Verifies: degraded boot (#183), chunk projection, frame painting,
 * clean dispose. Exits non-zero on failure — CI-usable.
 *
 * A real-TTY run (`node --import tsx/esm scripts/dev-tty.ts`, TODO) is still
 * required for keyboard/rendering feel; this harness only proves plumbing.
 */

import { bootstrapApp } from '../src/app.js'
import type { KernelContext, SessionEvent } from '../src/kernel/types.js'

class FakeKernel implements KernelContext {
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  on(name: string, listener: (...args: unknown[]) => void): void {
    const set = this.listeners.get(name) ?? new Set()
    set.add(listener)
    this.listeners.set(name, set)
  }

  // `agents` is intentionally unmounted to exercise the degraded boot path:
  // bootstrapApp must surface one system row, never throw (#183 discipline).
  get<T = unknown>(_name: string, _soft?: false): T | undefined {
    return undefined
  }

  effect(_register: () => (() => void) | void): void {
    // Effects are lifecycle-managed by the real kernel; smoke ignores them.
  }

  emit(event: SessionEvent): void {
    for (const listener of this.listeners.get('session/event') ?? []) {
      listener({ id: 'fake-session' }, event)
    }
  }
}

const writes: string[] = []
const fakeStdout = {
  columns: 100,
  write(chunk: string): boolean {
    writes.push(chunk)
    return true
  },
} as unknown as NodeJS.WriteStream
const fakeStdin = {
  on(): void {},
  removeListener(): void {},
  setRawMode(): void {},
  resume(): void {},
  pause(): void {},
} as unknown as NodeJS.ReadStream

const kernel = new FakeKernel()
const disposer = bootstrapApp(
  kernel,
  { provider: 'fake', fullscreen: false },
  { stdout: () => fakeStdout, stdin: () => fakeStdin },
)

// A canned turn streamed the way the kernel would: real deltas, not the
// committed-block-at-turn-end the old ACP wire protocol forced on us.
// Events arrive staggered so the diff painter exercises multiple frames.
const script: Array<[number, SessionEvent]> = [
  [0, { type: 'turn/start' }],
  [10, { type: 'assistant/chunk', text: '你好，Orca。' }],
  [50, { type: 'assistant/chunk', text: '流式增量上屏测试。' }],
  [100, { type: 'tool/call', tool: 'read', summary: 'src/app.ts' }],
  [180, { type: 'tool/result', output: 'ok' }],
  [220, { type: 'turn/end' }],
]
for (const [delay, event] of script) {
  setTimeout(() => kernel.emit(event), delay)
}

setTimeout(() => {
  disposer()
  const painted = writes.join('')
  const problems: string[] = []
  if (writes.length === 0) problems.push('没有帧写入')
  if (!painted.includes('你好，Orca。')) problems.push('assistant 流式转录缺失')
  if (!painted.includes('流式增量上屏测试。')) problems.push('增量 chunk 未并入同一行')
  if (!painted.includes('[✔] read')) problems.push('工具行未落到成功态')
  if (!painted.includes('就绪')) problems.push('turn/end 后状态未回就绪')
  if (!painted.includes('agents` 未挂载')) problems.push('降级启动提示缺失')
  if (problems.length > 0) {
    console.error(`smoke 失败：${problems.join('；')}`)
    process.exit(1)
  }
  console.log(`smoke 通过 ✔（${writes.length} 次帧写入，${Buffer.byteLength(painted)} 字节 ANSI）`)
  process.exit(0)
}, 450)
