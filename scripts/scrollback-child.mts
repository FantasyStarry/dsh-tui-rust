/**
 * Scrollback probe child: boots bootstrapApp against a compact fake kernel
 * wired to the REAL process.stdout/stdin (the parent runs it under a real
 * ConPTY). Each submitted prompt produces a long multi-line streamed reply
 * (per-turn markers) so the transcript overflows the viewport and crosses
 * turn boundaries — exactly the shape that exercises continuous sealing.
 *
 * Zero API cost: the kernel is fake; only the PTY round-trip is real.
 */

import { bootstrapApp } from '../src/app.js'
import { EventEmitter } from 'node:events'

const TURNS = Number(process.env['EXP_TURNS'] ?? '3')
const LINES = Number(process.env['EXP_LINES'] ?? '14')

const listeners = new Map<string, Set<(...args: unknown[]) => void>>()

function emit(session: { events: unknown[] }, type: string, data: unknown): void {
  const event = { type, seq: session.events.length + 1, time: Date.now(), data }
  session.events.push(event)
  for (const fn of listeners.get('session/event') ?? []) fn(session, event)
}

const ctx = {
  on(name: string, fn: (...args: unknown[]) => unknown): () => void {
    const set = listeners.get(name) ?? new Set()
    set.add(fn)
    listeners.set(name, set)
    return () => set.delete(fn)
  },
  get(name: string, _soft?: boolean): unknown {
    if (name === 'agents') {
      return {
        create: async () => {
          const session = {
            id: 'session-exp',
            events: [] as Array<{ type: string; seq: number; time: number; data: unknown }>,
            append(type: string, data: unknown) {
              const ev = { type, seq: session.events.length + 1, time: Date.now(), data }
              session.events.push(ev)
              return ev
            },
          }
          const agent = {
            id: 'a1',
            options: { provider: 'exp', model: 'exp-m' },
            session,
            status: 'idle' as const,
            ctx: { on: () => () => {} },
            followup(message: { content: Array<{ type: string; text?: string }> }) {
              const text = message.content.find((b) => b.type === 'text')?.text ?? ''
              session['turnNo'] = ((session['turnNo'] as number | undefined) ?? 0) + 1
              const turn = session['turnNo'] as number
              emit(session, 'turn/start', { turn })
              emit(session, 'user/message', message)
              let out = ''
              for (let i = 1; i <= LINES; i++) out += `T${turn}-L${i} —— ${text} 的回答行，内容用来在 scrollback 里找回\n`
              let idx = 0
              const step = 8
              const pump = (): void => {
                if (idx >= out.length) {
                  emit(session, {
                    type: 'assistant/message',
                    data: {
                      turn,
                      step: 0,
                      message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: out }], source: { kind: 'model' } },
                    },
                  })
                  emit(session, 'turn/end', { turn, reason: { kind: 'completed' } })
                  return
                }
                emit(session, 'assistant/chunk', { turn, step: 0, chunk: { type: 'text-delta', index: 0, text: out.slice(idx, idx + step) } })
                idx += step
                setTimeout(pump, 8)
              }
              pump()
            },
            steer() {},
            inject() {},
            cancel() {},
            whenIdle: async () => {},
          }
          return { agent, dispose: async () => {} }
        },
      }
    }
    if (name === 'agentDefaultModel') {
      return { currentSelection: () => ({ provider: 'exp', model: 'exp-m' }), saveSelection: async () => {} }
    }
    return undefined
  },
  effect(register: () => unknown): void {
    register()
  },
}

bootstrapApp(ctx as never, { provider: '', model: '', fullscreen: false }, {
  stdout: () => process.stdout,
  stdin: () => process.stdin,
})
