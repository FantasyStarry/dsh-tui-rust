/**
 * Structural mirrors of the DeepSeek Harness kernel seams that Orca consumes.
 *
 * Orca is an in-process Cordis plugin: at runtime inside a dsh profile these
 * shapes are satisfied by the real `@deepseek-ai/*` kernel services. The
 * mirrors exist so the package typechecks and runs standalone (fake kernel in
 * `scripts/dev.ts`) without vendoring the kernel. Every mirror here must
 * state the source seam it mirrors; when a mirror drifts from the real
 * surface, fix the mirror and note the kernel version it was checked against.
 *
 * Kernel surface reference: docs/research/deepseek-harness-research.md
 * (verified against dsh 0.1.2-alpha.3, 2026-08).
 */

/**
 * A persisted session event. The session event log is the single source of
 * truth for the transcript (dsh-TUI architecture doc: "Session 是真源").
 * Events arrive typed (`event.type`) with payload fields as an open record —
 * parse defensively, unknown types are ignored, never fatal.
 */
export interface SessionEvent {
  readonly type: string
  readonly [key: string]: unknown
}

/** Opaque reference to the live session behind an agent handle. */
export interface KernelSessionRef {
  readonly id: string
  /** Append a log-only event (no surfaceOp) to the session log. */
  append(type: string, payload: Readonly<Record<string, unknown>>): void
}

/**
 * A live agent handle. Mirrors the kernel AgentHandle surface used by UI
 * plugins: prompts go through followup/steer, in-flight work through cancel,
 * teardown through dispose (which quietly dismantles the agent scope).
 */
export interface KernelAgentHandle {
  readonly session: KernelSessionRef
  /** Deliver a user prompt; starts a model turn. */
  followup(text: string): Promise<void> | void
  /** Steer a running turn with an additional user message. */
  steer(text: string): Promise<void> | void
  /** Cancel in-flight work for the current prompt. */
  cancel(): void
  /** Dismantle the agent scope; flushes persistence. */
  dispose(): Promise<void> | void
}

export interface KernelAgentCreateOptions {
  readonly cwd: string
  readonly preset?: string
}

/**
 * The kernel agent factory (`ctx.agents`). Orca creates or resumes its agent
 * at runtime — no declarative agents at boot.
 */
export interface KernelAgentsService {
  create(options: KernelAgentCreateOptions): Promise<KernelAgentHandle> | KernelAgentHandle
  /** Resume a persisted session; history is restored from the session log. */
  resume(sessionId: string, options: KernelAgentCreateOptions): Promise<KernelAgentHandle> | KernelAgentHandle
}

/**
 * The subset of the Cordis `Context` Orca relies on.
 *
 * Discipline (dsh-ecosystem-spec #183): code-level inject stays empty; every
 * optional seam is soft-probed via `get(name, false)` and must degrade
 * silently when absent — an optional seam may never break the boot.
 */
export interface KernelContext {
  /** Subscribe to a kernel event (e.g. `session/event`, `agent/status`). */
  on(name: string, listener: (...args: unknown[]) => void): void
  /** Soft-probe a service; pass `false` to return undefined instead of throwing. */
  get<T = unknown>(name: string): T | undefined
  get<T = unknown>(name: string, soft: false): T | undefined
  /**
   * Register a reversible effect: the disposer runs when the plugin unloads
   * (hot reload, profile teardown). Orca's whole app tree hangs off one
   * effect so unmount always restores the terminal.
   */
  effect(register: () => (() => void) | void): void
}

/** Event names emitted by the kernel that Orca subscribes to. */
export const KERNEL_EVENTS = {
  sessionEvent: 'session/event',
  agentStatus: 'agent/status',
  sessionDisposed: 'session/disposed',
} as const
