/**
 * dsh-tui-companion — host-side companion plugin for the dsh-tui (Rust) client.
 *
 * Problem: the web GUI attaches new sessions to a workspace when its client
 * creates them (it passes workspaceId through the session controller). ACP
 * sessions (`session/new`) have no such surface, so TUI-created sessions
 * always land in "ungrouped" in the web sidebar — even with
 * `@deepseek-ai/dsh-workspace` mounted in the acp profile, because the
 * registry only auto-groups history during its one-time bootstrap.
 *
 * Fix: reconcile persisted session headers against registered workspaces by
 * canonical cwd, and attach live sessions as their first events arrive.
 * Everything rides the official `Workspace.attachSession` contract, which is
 * idempotent for accounted ids and rejects cwd mismatches without writing.
 *
 * Mounted in the acp profile via a patch insert row:
 *   - insert:
 *       - id: tui-companion
 *         name: dsh-tui-companion
 */

import { realpath } from "node:fs/promises";
import { appendFileSync } from "node:fs";

const DEBUG = process.env.DSH_TUI_COMPANION_DEBUG;
function log(msg) {
  if (!DEBUG) return;
  try {
    appendFileSync(DEBUG, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

/** Subagent sessions never join workspaces (the sidebar shows top-level only). */
function isRootSession(header) {
  return Boolean(
    header &&
      header.origin !== "subagent" &&
      !header.parentSession &&
      !(header.delegationDepth > 0),
  );
}

export default {
  name: "dsh-tui-companion",
  inject: ["workspaceRegistry", "sessionPersistence"],

  apply(ctx) {
    log("apply entered (services ready)");
    const registry = ctx.workspaceRegistry;
    const persistence = ctx.sessionPersistence;
    log(`registry=${typeof registry} persistence=${typeof persistence}`);

    /** Live sessions already attempted through the event path. */
    const attempted = new Set();

    /** Canonical cwd → matches the workspace path? Attach; mismatches no-op. */
    async function attachByCwd(sessionId, cwd) {
      if (!cwd) return;
      let canonical;
      try {
        canonical = await realpath(cwd);
      } catch {
        return; // cwd no longer resolves — registry would reject anyway
      }
      for (const ws of registry.list()) {
        if (ws.path !== canonical) continue;
        if (ws.sessionIds.includes(sessionId)) return; // already accounted
        try {
          await ws.attachSession(sessionId);
        } catch {
          // mismatch / transient rejection: never fatal for the session
        }
        return;
      }
    }

    /** Startup + periodic sweep: attach every persisted root session. */
    async function reconcile() {
      let headers;
      try {
        headers = await persistence.list();
      } catch (error) {
        log(`reconcile: persistence.list failed: ${error}`);
        return;
      }
      const workspaces = registry.list();
      log(`reconcile: ${headers.length} headers, ${workspaces.length} workspaces`);
      if (workspaces.length === 0) return;
      const byPath = new Map();
      for (const ws of workspaces) {
        byPath.set(ws.path, ws);
      }
      let attached = 0;
      let attemptedCount = 0;
      for (const entry of headers) {
        const header = entry?.header ?? entry;
        if (!isRootSession(header) || !header.id || !header.cwd) continue;
        const ws = byPath.get(await realpath(header.cwd).catch(() => null));
        if (!ws || ws.sessionIds.includes(header.id)) continue;
        attemptedCount += 1;
        try {
          await ws.attachSession(header.id);
          attached += 1;
        } catch (error) {
          log(`attach ${header.id} → ${ws.path} failed: ${error.message}`);
        }
      }
      log(`reconcile done, attempted ${attemptedCount}, attached ${attached}`);
    }

    // Live path: the first event of a session carries its header.
    ctx.on("session/event", (session) => {
      const header = session?.header;
      if (!isRootSession(header) || !header.id) return;
      if (attempted.has(header.id)) return;
      attempted.add(header.id);
      void attachByCwd(header.id, header.cwd);
    });

    // Belt-and-braces: sweep shortly after start (the registry's own
    // sessionPersistence dependency may still be starting when we run),
    // with retries, then periodically so anything missed converges.
    const timers = [3_000, 10_000, 30_000].map((delay) =>
      setTimeout(() => void reconcile(), delay),
    );
    const timer = setInterval(() => void reconcile(), 60_000);
    ctx.on("dispose", () => {
      for (const t of timers) clearTimeout(t);
      clearInterval(timer);
    });
  },
};
