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
 * ── Empty-session policy ────────────────────────────────────────────────
 * A session with ZERO appended events is TUI/probe residue (the kernel
 * writes only the header at `session/new`; content arrives with the first
 * prompt). Such sessions carry no `agentPreset` in their header either —
 * unlike web-created ones — and that combination poisons the web GUI: the
 * new-session screen reuses the workspace's newest blank as its staged
 * session, and its seat controller renders the mode picker only when that
 * session records an `agentPreset`. One leftover ACP blank therefore makes
 * the web's 模式选择器 disappear for the whole workspace. Policy:
 *
 *   1. Never attach an empty ACP session (sweep skips them; `session/created`
 *      no longer attaches at all — the first event is the attach signal).
 *   2. Once per boot, archive already-attached ACP sessions that are still
 *      empty and older than 1h (`registry.archiveSession` — hides them from
 *      the sidebar; zero data loss, the log holds nothing but a header).
 *
 * Web-created sessions (header carries `agentPreset`) keep the old
 * attach-everything semantics: they are the web client's own business.
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

/**
 * Age floor for archiving. With the never-attach rule in force, a fresh TUI
 * session never reaches a workspace's sessionIds while empty, so this only
 * guards the attach↔archive race (a session attached by the live first-event
 * path whose user content has not flushed yet). One minute is plenty; the
 * residue this fix targets is hours old.
 */
const ARCHIVE_MIN_AGE_MS = 60 * 1000;
/** Unattached ACP sessions examined per sweep pass (bounds persistence reads). */
const SWEEP_BUDGET = 25;

/**
 * Lifecycle events every composed session carries (kernel bootstrap + clean
 * close) — they never represent user content. A stored log holding nothing
 * beyond these is TUI/probe residue. Anything else (user/message, turn/*,
 * assistant/*, an unknown future type, …) counts as content, so the rule
 * fails safe: a residue is kept rather than a real session archived.
 */
const LIFECYCLE_EVENT_TYPES = new Set([
  "permission/preset",
  "sandbox/mode",
  "approval/policy",
  "session/end-seed",
  "model/selection",
]);

/** Whether a logical event log carries zero user content. */
function isEmptyLog(events) {
  return (events ?? []).every((event) => LIFECYCLE_EVENT_TYPES.has(event?.type));
}

/** Web-created sessions record their preset in the header; ACP ones never do. */
function isAcpOrigin(header) {
  return header.agentPreset === undefined || header.agentPreset === null;
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
    /** Emptiness verdicts within this boot: id → true (no events) / false. */
    const emptiness = new Map();
    /** The once-per-boot residue archive has run (or definitively failed). */
    let residueArchived = false;

    /**
     * Whether a stored session has zero events (pure residue: only the
     * `session/new` header). Memoized per boot; a session that gains
     * content later attaches through the live `session/event` path anyway.
     * A read failure counts as "not empty" so the legacy attach path decides.
     *
     * Uses `readFrom(id, 0)` — the backend-level primitive — because
     * `load()`/`inspect()` require the in-memory `sessions` service, which
     * is not resolvable from this plugin's context in the acp profile.
     */
    async function isEmpty(id) {
      if (emptiness.has(id)) return emptiness.get(id);
      let empty = false;
      try {
        const stored = await persistence.readFrom(id, 0);
        empty = isEmptyLog(stored?.events);
      } catch (error) {
        log(`read ${id} failed: ${error?.message ?? error}`);
      }
      emptiness.set(id, empty);
      return empty;
    }

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
      let budget = SWEEP_BUDGET;
      for (const entry of headers) {
        const header = entry?.header ?? entry;
        if (!isRootSession(header) || !header.id || !header.cwd) continue;
        if (isAcpOrigin(header)) {
          // Empty ACP sessions are residue — never join a workspace (see
          // the empty-session policy in the file header). The budget only
          // bounds fresh load()s; memoized verdicts are free.
          if (!emptiness.has(header.id)) {
            if (budget <= 0) continue;
            budget -= 1;
          }
          if (await isEmpty(header.id)) continue;
        }
        await attachByCwd(header.id, header.cwd);
      }
      log("reconcile done");
      if (!residueArchived) {
        // Once per boot: sweep out already-attached ACP residue left by
        // earlier runs (empty + older than the archive age floor).
        residueArchived = (await archiveEmptyResidue()) !== null;
      }
    }

    /**
     * Archive attached sessions that are ACP-created, empty, and older than
     * `ARCHIVE_MIN_AGE_MS`. Zero data loss — an empty log holds nothing but
     * its header — and the age floor keeps any live TUI session safe: it is
     * always younger than an hour when this once-per-boot pass runs.
     * Candidates are read concurrently (per-id chains serialize on the
     * backend), so even a large residue backlog passes in about a second.
     * @returns the number archived, or null when the pass could not run
     *   (persistence not ready) and should be retried on the next sweep.
     */
    async function archiveEmptyResidue() {
      let headers;
      try {
        headers = await persistence.list();
      } catch (error) {
        log(`archive: persistence.list failed: ${error}`);
        return null;
      }
      const byId = new Map();
      for (const entry of headers) {
        const header = entry?.header ?? entry;
        if (header?.id) byId.set(header.id, header);
      }
      const now = Date.now();
      const alreadyArchived = new Set(registry.archivedSessionIds ?? []);
      const candidates = [];
      for (const ws of registry.list()) {
        for (const sid of ws.sessionIds ?? []) {
          if (alreadyArchived.has(sid)) continue; // archive is idempotent; skip the reread
          const header = byId.get(sid);
          if (!header || !isAcpOrigin(header)) continue; // web-created or unknown
          if (emptiness.get(sid) === false) continue; // known to have content
          if (now - (header.createdAt ?? 0) < ARCHIVE_MIN_AGE_MS) continue;
          candidates.push({ sid, ws });
        }
      }
      let archived = 0;
      log(`archive pass: ${candidates.length} candidate(s) of ${headers.length} header(s)`);
      await Promise.all(candidates.map(async ({ sid, ws }) => {
        let stored;
        try {
          stored = await persistence.readFrom(sid, 0);
        } catch (error) {
          log(`archive read ${sid} failed: ${error?.message ?? error}`);
          return;
        }
        const empty = isEmptyLog(stored?.events);
        emptiness.set(sid, empty);
        if (!empty) return;
        try {
          await registry.archiveSession(sid);
          archived += 1;
          log(`archived empty ACP session ${sid} from ${ws.path}`);
        } catch (error) {
          log(`archive ${sid} failed: ${error?.message ?? error}`);
        }
      }));
      if (archived > 0) log(`archive pass done: ${archived} empty session(s) archived`);
      return archived;
    }

    // Live attach path: the first appended event of a session surfaces it on
    // the host scope immediately — the TUI's first prompt therefore groups the
    // session the moment the conversation starts. A bare `session/created`
    // carries no events by definition, so it must NOT attach (that is exactly
    // how residue blanks used to reach the workspace).
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
