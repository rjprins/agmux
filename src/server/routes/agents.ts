import path from "node:path";
import type { FastifyInstance } from "fastify";

import type { AgentProvider, AgentSessionCwdSource } from "../../types.js";
import { findLogFileForSession, readConversationMessages } from "../../logSessions.js";
import type { SqliteStore } from "../../persist/sqlite.js";
import { tmuxCreateLinkedSession, tmuxCreateWindow, tmuxEnsureSession } from "../../tmux.js";
import { parseJsonBody } from "../auth.js";
import {
  agentSessionPublicId,
  defaultAgentSessionName,
  normalizeAgentProvider,
  resumeArgsForProvider,
  type AgentSessionService,
} from "../agent-sessions.js";

type AgentRoutesDeps = {
  fastify: FastifyInstance;
  store: SqliteStore;
  agentSessions: AgentSessionService;
  worktrees: {
    isKnownWorktreePath: (path: string) => boolean;
    createWorktreeFromHead: (branch: string) => Promise<string>;
  };
  runtime: {
    ptys: { spawn: Function; list: Function; write: Function };
    broadcastPtyList: () => Promise<void>;
    trackLinkedSession: (ptyId: string, linkedSession: string, server: "agmux" | "default") => void;
  };
  repoRoot: string;
  agmuxSession: string;
};

const AGENT_PROVIDER_SET = new Set<AgentProvider>(["claude", "codex", "pi"]);

export function registerAgentRoutes(deps: AgentRoutesDeps): void {
  const { fastify, store, agentSessions, worktrees, runtime, repoRoot, agmuxSession } = deps;

  fastify.get("/api/agent-sessions", async () => {
    return { sessions: agentSessions.listAgentSessions() };
  });

  fastify.post("/api/agent-sessions/:provider/:sessionId/restore", async (req, reply) => {
    const params = req.params as Record<string, unknown>;
    const provider = normalizeAgentProvider(typeof params.provider === "string" ? params.provider : "");
    const providerSessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
    if (!provider || !providerSessionId) {
      reply.code(400);
      return { error: "provider and sessionId are required" };
    }
    if (!AGENT_PROVIDER_SET.has(provider)) {
      reply.code(400);
      return { error: "unsupported provider" };
    }

    const session = agentSessions.findAgentSessionSummary(provider, providerSessionId);
    if (!session) {
      reply.code(404);
      return { error: "unknown agent session" };
    }

    const body = parseJsonBody(req.body);
    const target = typeof body.target === "string" ? body.target.trim() : "same_cwd";
    if (target !== "same_cwd" && target !== "worktree" && target !== "new_worktree") {
      reply.code(400);
      return { error: "target must be same_cwd, worktree, or new_worktree" };
    }
    if (body.cwd != null && typeof body.cwd !== "string") {
      reply.code(400);
      return { error: "cwd must be a string" };
    }
    if (body.worktreePath != null && typeof body.worktreePath !== "string") {
      reply.code(400);
      return { error: "worktreePath must be a string" };
    }
    if (body.branch != null && typeof body.branch !== "string") {
      reply.code(400);
      return { error: "branch must be a string" };
    }

    let cwd = typeof body.cwd === "string" && body.cwd.trim().length > 0 ? body.cwd.trim() : session.cwd ?? undefined;
    let cwdSource: AgentSessionCwdSource = typeof body.cwd === "string" && body.cwd.trim().length > 0
      ? "user"
      : session.cwdSource;

    if (target === "worktree") {
      const worktreePath = typeof body.worktreePath === "string" ? body.worktreePath.trim() : "";
      if (!worktreePath) {
        reply.code(400);
        return { error: "worktreePath is required when target=worktree" };
      }
      const resolved = path.resolve(worktreePath);
      if (!worktrees.isKnownWorktreePath(resolved)) {
        reply.code(400);
        return { error: "worktreePath is not a known worktree" };
      }
      cwd = resolved;
      cwdSource = "user";
    }

    if (target === "new_worktree") {
      const rawBranch = typeof body.branch === "string" && body.branch.trim().length > 0
        ? body.branch.trim()
        : `restore-${Date.now()}`;
      try {
        const wtPath = await worktrees.createWorktreeFromHead(rawBranch);
        cwd = wtPath;
        cwdSource = "user";
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.code(409);
        return { error: message };
      }
    }

    if (!cwd) cwd = repoRoot;

    try {
      const shell = process.env.AGMUX_SHELL ?? process.env.SHELL ?? "bash";
      await tmuxEnsureSession(agmuxSession, shell);
      const tmuxTarget = await tmuxCreateWindow(agmuxSession, shell, cwd);
      const { linkedSession, attachArgs } = await tmuxCreateLinkedSession(tmuxTarget);

      const summary = runtime.ptys.spawn({
        name: session.name,
        backend: "tmux",
        tmuxSession: tmuxTarget,
        tmuxServer: "agmux",
        command: "tmux",
        args: attachArgs,
        cols: 120,
        rows: 30,
      });
      runtime.trackLinkedSession(summary.id, linkedSession, "agmux");
      const now = Date.now();
      store.upsertSession(summary);
      agentSessions.attachPtyToAgentSession(summary.id, provider, providerSessionId);

      const resumeArgs = resumeArgsForProvider(provider, providerSessionId);
      setTimeout(() => {
        const cmd = `unset CLAUDECODE; ${provider} ${resumeArgs.join(" ")}`;
        runtime.ptys.write(summary.id, `${cmd}\n`);
      }, 300);

      agentSessions.upsertAgentSessionSummary({
        ...session,
        id: agentSessionPublicId(provider, providerSessionId),
        name: session.name || defaultAgentSessionName(provider, providerSessionId, cwd ?? null),
        command: provider,
        args: resumeArgs,
        cwd: cwd ?? null,
        cwdSource,
        lastSeenAt: Math.max(session.lastSeenAt, now),
        lastRestoredAt: now,
      });

      fastify.log.info(
        { ptyId: summary.id, provider, providerSessionId, cwd: cwd ?? null, target, tmuxSession: tmuxTarget },
        "agent session restored (tmux)",
      );
      await runtime.broadcastPtyList();
      return { id: summary.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.code(500);
      return { error: message };
    }
  });

  fastify.get("/api/agent-sessions/:provider/:sessionId/conversation", async (req, reply) => {
    const params = req.params as Record<string, unknown>;
    const provider = normalizeAgentProvider(typeof params.provider === "string" ? params.provider : "");
    const providerSessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
    if (!provider || !providerSessionId) {
      reply.code(400);
      return { error: "provider and sessionId are required" };
    }

    const logPath = findLogFileForSession(provider, providerSessionId);
    if (!logPath) {
      reply.code(404);
      return { error: "log file not found for session" };
    }

    const messages = readConversationMessages(logPath);
    return { messages };
  });
}
