/**
 * Orca — a self-owned in-process TUI front door for DeepSeek Harness.
 *
 * Cordis plugin contract (dsh-ecosystem-spec): the package root exports
 * exactly `name`, `Config`, `apply` — no default export. All config keys
 * carry defaults so a missing/misconfigured plugin degrades to "nothing
 * happened", never a failed boot.
 */

import { bootstrapApp } from './app.js'
import type { KernelContext } from './kernel/types.js'

export const name = 'orca'

export interface OrcaConfig {
  /** LLM routing preset handed to the agent factory. */
  provider: string
  /** Alternate-screen fullscreen (target experience) vs inline main screen. */
  fullscreen: boolean
}

/**
 * Schema-lite default table. Once the package is mounted in a real profile
 * this becomes a Schemastery object (`@deepseek-ai/schemastery`, the same
 * schema system the kernel uses) — the shape of the exported `Config`
 * constant will not change.
 */
export const Config: OrcaConfig = {
  provider: 'deepseek-official',
  fullscreen: false,
}

export function apply(ctx: KernelContext, config: Partial<OrcaConfig> = {}): void {
  const resolved: OrcaConfig = { ...Config, ...config }

  // The whole app tree hangs off one effect: plugin unload (hot reload,
  // profile teardown) unmounts the TUI, restores the terminal, disposes the
  // agent — and never leaves the process wedged in raw mode.
  ctx.effect(() => {
    // TTY gate: without a terminal there is nothing to render and nothing to
    // drive; stay silent so headless compositions keep working.
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      return undefined
    }
    return bootstrapApp(ctx, resolved)
  })
}
