import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { PtyManager } from "../pty/manager.js";
import { ReadinessEngine, type PtyReadyEvent } from "../readiness/engine.js";
import { TriggerEngine } from "../triggers/engine.js";
import { TriggerLoader } from "../triggers/loader.js";
import { WsHub } from "../ws/hub.js";
import type { PtySummary, ServerToClientMessage } from "../types.js";
import type { SqliteStore } from "../persist/sqlite.js";
import {
  tmuxCreateLinkedSession,
  tmuxKillSession,
  tmuxListWindows,
  tmuxPaneCurrentPath,
  tmuxPruneDetachedLinkedSessions,
  tmuxTargetSession,
  tmuxEnsureSession,
  type TmuxServer,
} from "../tmux.js";

export type RuntimeDeps = {
  store: SqliteStore;
  logger: FastifyBaseLogger;
  agentSessions: {
    persistRuntimeCwdForAgentPty: (ptyId: string, cwd: string | null | undefined, ts: number) => void;
    detachPty: (ptyId: string) => void;
  };
  readinessTraceMax: number;
  readinessTraceLog: boolean;
  triggersPath: string;
  agmuxSession: string;
  refreshWorktrees: () => void;
};

type ReadinessTraceEntry = PtyReadyEvent & { seq: number };

export function createRuntime(deps: RuntimeDeps) {
  const { store, logger, agentSessions, readinessTraceMax, readinessTraceLog, triggersPath, agmuxSession, refreshWorktrees } = deps;
  const ptys = new PtyManager();
  const hub = new WsHub();
  const triggerEngine = new TriggerEngine();
  const triggerLoader = new TriggerLoader(triggersPath);

  const linkedSessionsByPty = new Map<string, { name: string; server: TmuxServer }>();

  const readinessTrace: ReadinessTraceEntry[] = [];
  let readinessTraceSeq = 0;
  const cwdPollIntervalMs = 2000;

  function recordReadinessTrace(evt: PtyReadyEvent): void {
    readinessTrace.push({ ...evt, seq: readinessTraceSeq++ });
    if (readinessTrace.length > readinessTraceMax) {
      readinessTrace.splice(0, readinessTrace.length - readinessTraceMax);
    }
    if (readinessTraceLog) {
      logger.info(
        {
          ptyId: evt.ptyId,
          state: evt.state,
          indicator: evt.indicator,
          reason: evt.reason,
          source: evt.source,
          ts: evt.ts,
        },
        "readiness decision",
      );
    }
  }

  function broadcast(evt: ServerToClientMessage): void {
    hub.broadcast(evt);
    if (evt.type === "trigger_fired") {
      store.insertEvent({
        sessionId: evt.ptyId,
        ts: evt.ts,
        type: evt.type,
        payload: evt,
      });
    }
  }

  const readinessEngine = new ReadinessEngine({
    ptys,
    emitReadiness: ({ ptyId, state, indicator, reason, ts, cwd, source, activeProcess }) => {
      agentSessions.persistRuntimeCwdForAgentPty(ptyId, cwd, ts);
      recordReadinessTrace({ ptyId, state, indicator, reason, source, ts, cwd, activeProcess });
      broadcast({ type: "pty_ready", ptyId, state, indicator, reason, ts, cwd, activeProcess });
    },
  });

  // Periodically refresh cwd from tmux in case readiness misses a fast cwd change.
  setInterval(() => {
    const running = ptys.list().filter((p) => p.status === "running" && p.tmuxSession);
    for (const p of running) {
      if (!p.tmuxSession) continue;
      void tmuxPaneCurrentPath(p.tmuxSession, p.tmuxServer)
        .then((cwd) => {
          if (!cwd || cwd === p.cwd) return;
          readinessEngine.markCwd(p.id, cwd);
        })
        .catch(() => {
          // ignore best-effort polling failures
        });
    }
  }, cwdPollIntervalMs);

  async function listPtys(): Promise<PtySummary[]> {
    return readinessEngine.withActiveProcesses(ptys.list());
  }

  async function broadcastPtyList(): Promise<void> {
    broadcast({ type: "pty_list", ptys: await listPtys() });
  }

  function stripAlternateScreenSequences(s: string): string {
    return s
      .replaceAll("\x1b[?1049h", "")
      .replaceAll("\x1b[?1049l", "")
      .replaceAll("\x1b[?47h", "")
      .replaceAll("\x1b[?47l", "")
      .replaceAll("\x1b[?1047h", "")
      .replaceAll("\x1b[?1047l", "");
  }

  // PTY events -> persistence + triggers + WS
  ptys.on("output", (ptyId: string, data: string) => {
    const out = stripAlternateScreenSequences(data);
    readinessEngine.markOutput(ptyId, out);

    hub.queuePtyOutput(ptyId, out);
    triggerEngine.onOutput(
      ptyId,
      out,
      (evt) => {
        const type = (evt as any)?.type;
        if (typeof type !== "string") return;
        if (type === "trigger_fired" || type === "pty_highlight") {
          broadcast(evt as any);
          return;
        }
        hub.broadcast(evt as any);
      },
      (id, d) => ptys.write(id, d),
    );
  });

  ptys.on("exit", (ptyId: string, code: number | null, signal: string | null) => {
    const summary = ptys.getSummary(ptyId);
    if (summary) store.upsertSession(summary);
    readinessEngine.markExited(ptyId);
    agentSessions.detachPty(ptyId);
    logger.info({ ptyId, code, signal }, "pty exited");
    broadcast({ type: "pty_exit", ptyId, code, signal });

    const linked = linkedSessionsByPty.get(ptyId);
    if (linked) {
      linkedSessionsByPty.delete(ptyId);
      tmuxKillSession(linked.name, linked.server).catch(() => {});
    }

    if (summary?.tmuxSession && summary.tmuxServer !== "default") {
      void (async () => {
        await new Promise((r) => setTimeout(r, 250));
        await reconcileTmuxAttachments();
        await broadcastPtyList();
      })();
    }
  });

  let reconciling = false;

  async function reconcileTmuxAttachments(): Promise<void> {
    if (reconciling) return;
    reconciling = true;
    try {
      const windows = await tmuxListWindows(agmuxSession);
      const windowTargets = new Set(windows.map((w) => w.target));

      const runningByTarget = new Map<string, string>();
      // Track PTYs that target a whole session (no window specifier) — these
      // cover every window in that session and must not be duplicated.
      const sessionLevelPtyIds = new Set<string>();
      for (const p of ptys.list()) {
        if (
          p.status === "running" &&
          p.tmuxSession &&
          p.tmuxServer !== "default" &&
          tmuxTargetSession(p.tmuxSession) === agmuxSession
        ) {
          if (runningByTarget.has(p.tmuxSession)) {
            ptys.kill(p.id);
            logger.info({ ptyId: p.id, tmuxSession: p.tmuxSession }, "killed duplicate PTY for same window");
            continue;
          }
          runningByTarget.set(p.tmuxSession, p.id);
          if (!p.tmuxSession.includes(":")) {
            sessionLevelPtyIds.add(p.id);
          }
        }
      }

      const shell = process.env.AGMUX_SHELL ?? process.env.SHELL ?? "bash";
      for (const w of windows) {
        if (!runningByTarget.has(w.target) && !runningByTarget.has(agmuxSession)) {
          const { linkedSession, attachArgs } = await tmuxCreateLinkedSession(w.target);
          const summary = ptys.spawn({
            name: `shell:${path.basename(shell)}`,
            backend: "tmux",
            tmuxSession: w.target,
            tmuxServer: "agmux",
            command: "tmux",
            args: attachArgs,
            cols: 120,
            rows: 30,
          });
          linkedSessionsByPty.set(summary.id, { name: linkedSession, server: "agmux" });
          store.upsertSession(summary);
          logger.info({ ptyId: summary.id, tmuxSession: w.target }, "reconcile: attached orphaned window");
        }
      }

      for (const [target, ptyId] of runningByTarget) {
        // Session-level PTYs (no window specifier) are not expected to match a
        // specific window target — skip them to avoid false kills.
        if (sessionLevelPtyIds.has(ptyId)) continue;
        if (!windowTargets.has(target)) {
          ptys.kill(ptyId);
          logger.info({ ptyId, tmuxSession: target }, "reconcile: killed PTY for missing window");
        }
      }
    } finally {
      reconciling = false;
    }
  }

  async function loadTriggersAndBroadcast(reason: string): Promise<void> {
    try {
      const { triggers, version } = await triggerLoader.load();
      triggerEngine.setTriggers(triggers);
      logger.info({ reason, version, count: triggers.length }, "Triggers loaded");
    } catch (err) {
      triggerEngine.setTriggers(triggerLoader.lastGoodTriggers());
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, "Trigger reload failed");
      broadcast({
        type: "trigger_error",
        ptyId: "system",
        trigger: "reload",
        ts: Date.now(),
        message,
      });
    }
  }

  async function restoreAtStartup(): Promise<void> {
    refreshWorktrees();
    const shell = process.env.AGMUX_SHELL ?? process.env.SHELL ?? "bash";
    await tmuxEnsureSession(agmuxSession, shell);
    const pruned = await tmuxPruneDetachedLinkedSessions(agmuxSession);
    if (pruned.length > 0) {
      logger.info({ count: pruned.length }, "pruned stale linked tmux sessions");
    }
    await reconcileTmuxAttachments();
  }

  function trackLinkedSession(ptyId: string, linkedSession: string, server: TmuxServer): void {
    linkedSessionsByPty.set(ptyId, { name: linkedSession, server });
  }

  function getReadinessTrace(opts?: { ptyId?: string | null; limit?: number }): ReadinessTraceEntry[] {
    const limit = opts?.limit ?? 200;
    const filtered = opts?.ptyId ? readinessTrace.filter((evt) => evt.ptyId === opts.ptyId) : readinessTrace;
    return filtered.slice(-limit);
  }

  return {
    ptys,
    hub,
    readinessEngine,
    triggerLoader,
    listPtys,
    broadcast,
    broadcastPtyList,
    loadTriggersAndBroadcast,
    restoreAtStartup,
    reconcileTmuxAttachments,
    trackLinkedSession,
    getReadinessTrace,
  };
}
