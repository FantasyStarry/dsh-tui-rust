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
 * Fix: attach sessions to the workspace owning their canonical cwd, and
 * auto-create a workspace when none exists (mirroring the registry's own
 * bootstrap, which gives every session path a workspace at first init). Two
 * triggers:
 *
 *  1. Live path — `session/event` fires the moment a session appends its
 *     first event (the TUI's first prompt), attaching immediately with
 *     auto-create. (`session/created` is emitted only inside agent scopes,
 *     so a host plugin cannot rely on it; we still listen defensively.)
 *  2. Sweep — 3s/10s/30s after start, then every 15s, every persisted root
 *     session is reconciled the same way, so a session that never appended
 *     an event still converges within seconds (registered dirs attach, and
 *     genuinely new project dirs get a workspace created).
 *
 * Everything rides the official `Workspace.create`/`attachSession`
 * contracts: create is idempotent per canonical path, attach is idempotent
 * for accounted ids and rejects cwd mismatches without writing.
 *
 * Mounted in the acp profile via a patch insert row:
 *   - insert:
 *       - id: tui-companion
 *         name: dsh-tui-companion
 */

import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename } from "node:path";
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

  apply(ctx, config) {
    log("apply entered (services ready)");
    const registry = ctx.workspaceRegistry;
    const persistence = ctx.sessionPersistence;
    const createIfMissing = config?.createIfMissing ?? true;
    const home = homedir();
    log(`registry=${typeof registry} persistence=${typeof persistence} createIfMissing=${createIfMissing}`);

    /** Live sessions already attempted through the event paths. */
    const attempted = new Set();

    /**
     * Canonicalize a session cwd, or return undefined when it is unusable.
     * The home directory never becomes a workspace (avoids a junk "Mayn"
     * workspace when the TUI is launched from $HOME).
     */
    async function canonicalCwd(cwd) {
      if (!cwd) return undefined;
      try {
        const canonical = await realpath(cwd);
        const info = await stat(canonical);
        if (!info.isDirectory()) return undefined;
        if (canonical === home) return undefined;
        return canonical;
      } catch {
        return undefined;
      }
    }

    /** Find the workspace owning a canonical path, if any. */
    function workspaceAt(canonical) {
      for (const ws of registry.list()) {
        if (ws.path === canonical) return ws;
      }
      return undefined;
    }

    /**
     * Attach one session to the workspace owning its cwd, creating the
     * workspace first when none is registered for the path. Session ids
     * already accounted by a workspace are skipped; `attachSession` rejects
     * cwd mismatches without writing, so this can never mis-file a session.
     */
    async function attachByCwd(sessionId, cwd) {
      const canonical = await canonicalCwd(cwd);
      if (canonical === undefined) return;
      let ws = workspaceAt(canonical);
      if (ws === undefined) {
        if (!createIfMissing) return;
        try {
          ws = await registry.create(canonical, basename(canonical));
          log(`auto-created workspace for ${canonical}`);
        } catch (error) {
          log(`create workspace ${canonical} failed: ${error?.message ?? error}`);
          return;
        }
      }
      if (ws.sessionIds.includes(sessionId)) return; // already accounted
      try {
        await ws.attachSession(sessionId);
        log(`attached ${sessionId} -> ${ws.path}`);
      } catch (error) {
        // mismatch / transient rejection: never fatal for the session
        log(`attach ${sessionId} -> ${ws.path} failed: ${error?.message ?? error}`);
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
      let attemptedCount = 0;
      for (const entry of headers) {
        const header = entry?.header ?? entry;
        if (!isRootSession(header) || !header.id || !header.cwd) continue;
        attemptedCount += 1;
        await attachByCwd(header.id, header.cwd);
      }
      log(`reconcile done, attempted ${attemptedCount}`);
    }

    // Live path 1 (defensive): `session/created` is normally emitted only in
    // agent-scoped contexts, so a host plugin usually never sees it — but
    // when it does, attach before the first event even exists.
    ctx.on("session/created", (session) => {
      const header = session?.header;
      if (!isRootSession(header) || !header.id) return;
      if (attempted.has(header.id)) return;
      attempted.add(header.id);
      void attachByCwd(header.id, header.cwd);
    });

    // Live path 2: the first appended event of a session surfaces it on the
    // host scope immediately — the TUI's first prompt therefore groups the
    // session the moment the conversation starts.
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
    const timer = setInterval(() => void reconcile(), 15_000);
    ctx.on("dispose", () => {
      for (const t of timers) clearTimeout(t);
      clearInterval(timer);
    });
  },
};
