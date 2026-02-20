import path from "node:path";
import type { FastifyInstance } from "fastify";

import type { SqliteStore } from "../../persist/sqlite.js";
import {
  tmuxApplySessionUiOptions,
  tmuxCreateLinkedSession,
  tmuxCreateWindow,
  tmuxEnsureSession,
  tmuxIsLinkedViewSession,
  tmuxKillWindow,
  tmuxListWindows,
  tmuxLocateSession,
  type TmuxServer,
} from "../../tmux.js";
import { parseJsonBody } from "../auth.js";

type PtyRoutesDeps = {
  fastify: FastifyInstance;
  store: SqliteStore;
  runtime: {
    ptys: { spawn: Function; list: Function; getSummary: Function; kill: Function; write: Function; resize: Function };
    readinessEngine: { markExited: Function };
    listPtys: () => Promise<unknown>;
    broadcastPtyList: () => Promise<void>;
    trackLinkedSession: (ptyId: string, linkedSession: string, server: TmuxServer) => void;
    getReadinessTrace: (opts?: { ptyId?: string | null; limit?: number }) => Array<unknown>;
  };
  worktrees: {
    resolveProjectRoot: (raw: unknown) => Promise<string | null>;
    createWorktreeFromBase: (opts: { projectRoot?: string | null; branch: string; baseBranch?: string }) => Promise<string>;
    directoryExists: (path: string) => Promise<boolean>;
  };
  defaultBaseBranch: string;
  agmuxSession: string;
};

const FLAG_DEFAULTS: Record<string, Record<string, string>> = {
  claude: { "--permission-mode": "default" },
  codex: { "--ask-for-approval": "untrusted", "--sandbox": "read-only" },
};

function agentCommand(agent: string, flags: Record<string, string | boolean>): string {
  const defaults = FLAG_DEFAULTS[agent] ?? {};
  const parts = [agent];
  for (const [flag, value] of Object.entries(flags)) {
    if (typeof value === "boolean") {
      if (value) parts.push(flag);
    } else if (typeof value === "string" && value && value !== defaults[flag]) {
      parts.push(`${flag} ${value}`);
    }
  }
  return parts.join(" ");
}

export function registerPtyRoutes(deps: PtyRoutesDeps): void {
  const { fastify, store, runtime, worktrees, defaultBaseBranch, agmuxSession } = deps;

  fastify.get("/api/ptys", async () => {
    return { ptys: await runtime.listPtys() };
  });

  fastify.get("/api/readiness/trace", async (req) => {
    const q = req.query as Record<string, unknown>;
    const ptyId = typeof q.ptyId === "string" && q.ptyId.trim().length > 0 ? q.ptyId.trim() : null;
    const parsedLimit = Number(q.limit);
    const limit = Number.isInteger(parsedLimit) ? Math.max(1, Math.min(2000, parsedLimit)) : 200;
    const events = runtime.getReadinessTrace({ ptyId, limit });
    return { events };
  });

  fastify.post("/api/ptys/launch", async (req, reply) => {
    const body = parseJsonBody(req.body);
    const agent = typeof body.agent === "string" ? body.agent.trim() : "";
    const worktree = typeof body.worktree === "string" ? body.worktree.trim() : "";
    if (!agent) {
      reply.code(400);
      return { error: "agent is required" };
    }
    if (!worktree) {
      reply.code(400);
      return { error: "worktree is required" };
    }

    const projectRoot = await worktrees.resolveProjectRoot(body.projectRoot);
    if (body.projectRoot && !projectRoot) {
      reply.code(400);
      return { error: `project directory not found: ${body.projectRoot}` };
    }

    let cwd: string;
    if (worktree === "__new__") {
      const branch = typeof body.branch === "string" && body.branch.trim()
        ? body.branch.trim()
        : `wt-${Date.now()}`;
      const baseBranch = typeof body.baseBranch === "string" && body.baseBranch.trim().length > 0
        ? body.baseBranch.trim()
        : defaultBaseBranch;
      try {
        cwd = await worktrees.createWorktreeFromBase({ projectRoot, branch, baseBranch });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.code(400);
        return { error: message };
      }
    } else {
      if (!(await worktrees.directoryExists(worktree))) {
        reply.code(400);
        return { error: "worktree path does not exist or is not a directory" };
      }
      cwd = path.resolve(worktree);
    }

    const shell = process.env.AGMUX_SHELL ?? process.env.SHELL ?? "bash";
    const SESSION_NAME = agmuxSession;
    try {
      await tmuxEnsureSession(SESSION_NAME, shell);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("shell must")) {
        reply.code(400);
        return { error: message };
      }
      throw err;
    }

    const tmuxTarget = await tmuxCreateWindow(SESSION_NAME, shell, cwd);
    const { linkedSession, attachArgs } = await tmuxCreateLinkedSession(tmuxTarget);

    const name = `shell:${path.basename(shell)}`;
    const summary = runtime.ptys.spawn({
      name,
      backend: "tmux",
      tmuxSession: tmuxTarget,
      tmuxServer: "agmux",
      command: "tmux",
      args: attachArgs,
      cols: 120,
      rows: 30,
    });
    runtime.trackLinkedSession(summary.id, linkedSession, "agmux");
    store.upsertSession(summary);
    fastify.log.info({ ptyId: summary.id, agent, cwd, tmuxSession: tmuxTarget }, "launch: shell spawned");
    await runtime.broadcastPtyList();

    if (agent !== "shell") {
      const flags = typeof body.flags === "object" && body.flags ? body.flags as Record<string, string | boolean> : {};
      setTimeout(() => {
        const cmd = agentCommand(agent, flags);
        runtime.ptys.write(summary.id, `unset CLAUDECODE; ${cmd}\n`);
      }, 300);
    }

    const agentFlags = typeof body.flags === "object" && body.flags ? body.flags : {};
    const prev = store.getPreference<{ agent?: string; flags?: Record<string, unknown> }>("launch") ?? {};
    const allFlags = { ...(prev.flags ?? {}), [agent]: agentFlags };
    store.setPreference("launch", { agent, flags: allFlags });

    return { id: summary.id };
  });

  fastify.post("/api/ptys/shell", async (_req, reply) => {
    const shell = process.env.AGMUX_SHELL ?? process.env.SHELL ?? "bash";
    try {
      await tmuxEnsureSession(agmuxSession, shell);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("shell must")) {
        reply.code(400);
        return { error: message };
      }
      throw err;
    }

    const windows = await tmuxListWindows(agmuxSession);
    const attachedTargets = new Set(
      runtime.ptys
        .list()
        .filter((p: any) => p.tmuxSession && p.tmuxServer !== "default")
        .map((p: any) => p.tmuxSession),
    );
    let tmuxTarget: string | null = null;
    for (const w of windows) {
      if (!attachedTargets.has(w.target)) {
        tmuxTarget = w.target;
        break;
      }
    }
    if (!tmuxTarget) {
      tmuxTarget = await tmuxCreateWindow(agmuxSession, shell);
    }
    const { linkedSession, attachArgs } = await tmuxCreateLinkedSession(tmuxTarget);
    const name = `shell:${path.basename(shell)}`;
    const summary = runtime.ptys.spawn({
      name,
      backend: "tmux",
      tmuxSession: tmuxTarget,
      tmuxServer: "agmux",
      command: "tmux",
      args: attachArgs,
      cols: 120,
      rows: 30,
    });
    runtime.trackLinkedSession(summary.id, linkedSession, "agmux");
    store.upsertSession(summary);
    fastify.log.info({ ptyId: summary.id, shell, tmuxSession: tmuxTarget }, "shell spawned");
    await runtime.broadcastPtyList();
    return { id: summary.id };
  });

  fastify.post("/api/ptys/attach-tmux", async (req, reply) => {
    const body = parseJsonBody(req.body);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const requestedServer = body.server;
    if (!name) {
      reply.code(400);
      return { error: "name is required" };
    }
    if (requestedServer != null && requestedServer !== "agmux" && requestedServer !== "default") {
      reply.code(400);
      return { error: "server must be agmux or default" };
    }

    const preferredServer: TmuxServer | undefined = requestedServer === "agmux" || requestedServer === "default"
      ? requestedServer
      : undefined;
    const located = await tmuxLocateSession(name, preferredServer);
    if (!located) {
      reply.code(404);
      return { error: "tmux session not found" };
    }
    if (requestedServer != null && requestedServer !== located) {
      reply.code(409);
      return { error: `tmux session exists on ${located}, not ${requestedServer}` };
    }
    if (located === "agmux" && tmuxIsLinkedViewSession(name, agmuxSession)) {
      reply.code(400);
      return { error: "internal linked session cannot be attached directly" };
    }
    const server: TmuxServer = located;
    try {
      await tmuxApplySessionUiOptions(name, server);
    } catch {
      // Ignore best-effort option sync; attach can continue.
    }

    const { linkedSession, attachArgs } = await tmuxCreateLinkedSession(name, server);
    const summary = runtime.ptys.spawn({
      name: `tmux:${name}`,
      backend: "tmux",
      tmuxSession: name,
      tmuxServer: server,
      command: "tmux",
      args: attachArgs,
      cols: 120,
      rows: 30,
    });
    runtime.trackLinkedSession(summary.id, linkedSession, server);
    store.upsertSession(summary);
    await runtime.broadcastPtyList();
    return { id: summary.id };
  });

  fastify.post("/api/ptys/:id/kill", async (req, reply) => {
    const id = (req.params as any).id as string;
    const summary = runtime.ptys.getSummary(id);
    if (!summary) {
      reply.code(404);
      return { error: "unknown PTY" };
    }
    if (summary.tmuxSession) {
      try {
        await tmuxKillWindow(summary.tmuxSession, summary.tmuxServer);
      } catch {
        // If it's already gone, continue with local cleanup.
      }
    }
    runtime.ptys.kill(id);
    fastify.log.info({ ptyId: id }, "pty killed");

    const after = runtime.ptys.getSummary(id) ?? summary;
    after.status = "exited";
    after.exitCode = after.exitCode ?? null;
    after.exitSignal = after.exitSignal ?? null;
    store.upsertSession(after);
    runtime.readinessEngine.markExited(id);
    await runtime.broadcastPtyList();
    return { ok: true };
  });

  fastify.post("/api/ptys/:id/resume", async (req, reply) => {
    const id = (req.params as any).id as string;
    const live = runtime.ptys.getSummary(id);
    if (live?.status === "running") {
      return { id: live.id, reused: true };
    }
    reply.code(410);
    return {
      error:
        "runtime session resume is deprecated: tmux/runtime terminals reconnect automatically; use /api/agent-sessions/.../restore for Claude/Codex/Pi session restore",
    };
  });

  fastify.get("/api/input-history", async () => {
    return { history: store.loadAllInputHistory() };
  });

  fastify.put("/api/ptys/:id/input-history", async (req) => {
    const id = (req.params as any).id as string;
    const body = parseJsonBody(req.body);
    const history = Array.isArray(body.history) ? body.history : [];
    const lastInput = typeof body.lastInput === "string" ? body.lastInput : undefined;
    const processHint = typeof body.processHint === "string" ? body.processHint : undefined;
    const entries = history
      .filter((x: any) => x && typeof x.text === "string" && x.text.trim().length > 0)
      .map((x: any) => ({
        text: String(x.text),
        bufferLine: typeof x.bufferLine === "number" ? x.bufferLine : 0,
      }))
      .slice(-40);
    store.saveInputHistory(id, { lastInput, processHint, history: entries });
    return { ok: true };
  });
}
