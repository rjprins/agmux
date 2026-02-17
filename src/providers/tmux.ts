import path from "node:path";
import process from "node:process";

import type { PtyManager } from "../pty/manager.js";
import type { PtySummary } from "../types.js";
import {
  tmuxApplySessionUiOptions,
  tmuxAttachArgs,
  tmuxCapturePaneVisible,
  tmuxCheckSessionConfig,
  tmuxKillWindow,
  tmuxListSessions,
  tmuxLocateSession,
  tmuxNewSessionDetached,
  tmuxPaneActiveProcess,
  tmuxPaneCurrentPath,
  type TmuxServer,
  type TmuxSessionCheck,
  type TmuxSessionInfo,
} from "../tmux.js";
import {
  providerCapabilities,
  type RuntimeAttachRequest,
  type RuntimeOutputRequest,
  type RuntimeProvider,
  type RuntimeResizeRequest,
  type RuntimeSendRequest,
  type RuntimeStartRequest,
  type RuntimeStopRequest,
  type StatusProvider,
  type StatusSnapshot,
  type WorktreeCleanupRequest,
  type WorktreeCreateRequest,
  type WorktreeFinishRequest,
  type WorktreeProvider,
  type WorktreeSummary,
} from "./types.js";

type TmuxProviderDeps = {
  ptys: Pick<PtyManager, "spawn" | "getSummary" | "write" | "resize" | "kill">;
  now?: () => number;
};

function getMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  if (!metadata) return null;
  const value = metadata[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function notImplemented(action: string): never {
  throw new Error(`tmux provider ${action} is not implemented yet`);
}

export class TmuxProvider implements RuntimeProvider, StatusProvider, WorktreeProvider {
  readonly id = "tmux" as const;
  readonly capabilities = providerCapabilities({
    add: true,
    start: true,
    stop: true,
    attach: true,
    send: true,
    output: true,
    resize: true,
  });

  private readonly now: () => number;

  constructor(private readonly deps: TmuxProviderDeps) {
    this.now = deps.now ?? Date.now;
  }

  async listNativeSessions(): Promise<TmuxSessionInfo[]> {
    return tmuxListSessions();
  }

  async checkSession(name: string, server: TmuxServer): Promise<TmuxSessionCheck> {
    return tmuxCheckSessionConfig(name, server);
  }

  async start(request: RuntimeStartRequest): Promise<PtySummary> {
    const shell = request.command.trim();
    if (!shell) throw new Error("tmux provider start requires a shell command");

    const sessionName = getMetadataString(request.metadata, "tmuxSession") ?? `agent_tide_shell_${Date.now()}`;
    await tmuxNewSessionDetached(sessionName, shell);
    return this.spawnAttachedSession({
      id: request.id,
      name: request.name ?? `shell:${path.basename(shell)}`,
      sessionName,
      server: "agent_tide",
      cols: request.cols,
      rows: request.rows,
    });
  }

  async attach(request: RuntimeAttachRequest): Promise<PtySummary> {
    const requestedServer = getMetadataString(request.metadata, "server");
    if (requestedServer && requestedServer !== "agent_tide" && requestedServer !== "default") {
      throw new Error("tmux provider attach metadata.server must be agent_tide or default");
    }

    const located = await tmuxLocateSession(request.target);
    if (!located) {
      throw new Error(`tmux session not found: ${request.target}`);
    }
    if (requestedServer && requestedServer !== located) {
      throw new Error(`tmux session ${request.target} exists on ${located}, not ${requestedServer}`);
    }

    try {
      await tmuxApplySessionUiOptions(request.target, located);
    } catch {
      // UI options are best-effort; attach can continue.
    }

    return this.spawnAttachedSession({
      id: request.id,
      name: request.name ?? `tmux:${request.target}`,
      sessionName: request.target,
      server: located,
      cols: request.cols,
      rows: request.rows,
    });
  }

  async stop(request: RuntimeStopRequest): Promise<void> {
    const summary = this.deps.ptys.getSummary(request.id);
    if (!summary) return;
    if (summary.backend === "tmux" && summary.tmuxSession) {
      try {
        await tmuxKillWindow(summary.tmuxSession);
      } catch {
        // If the tmux window is already gone we still kill local attachment.
      }
    }
    this.deps.ptys.kill(request.id);
  }

  async send(request: RuntimeSendRequest): Promise<void> {
    this.deps.ptys.write(request.id, request.data);
  }

  async resize(request: RuntimeResizeRequest): Promise<void> {
    this.deps.ptys.resize(request.id, request.cols, request.rows);
  }

  async output(request: RuntimeOutputRequest): Promise<string | null> {
    const summary = this.deps.ptys.getSummary(request.id);
    if (!summary || !summary.tmuxSession) return null;
    const snapshot = await tmuxCapturePaneVisible(summary.tmuxSession);
    if (!snapshot) return null;
    if (request.maxBytes == null || request.maxBytes <= 0 || snapshot.length <= request.maxBytes) {
      return snapshot;
    }
    return snapshot.slice(-request.maxBytes);
  }

  async status(id: string): Promise<StatusSnapshot> {
    const summary = this.deps.ptys.getSummary(id);
    if (!summary) {
      return {
        id,
        readiness: "unknown",
        sessionState: "error",
        reason: "missing-session",
        observedAt: this.now(),
        activeProcess: null,
        cwd: null,
      };
    }

    if (summary.status !== "running") {
      return {
        id,
        readiness: "busy",
        sessionState: "error",
        reason: "exited",
        observedAt: this.now(),
        activeProcess: summary.activeProcess ?? null,
        cwd: summary.cwd ?? null,
      };
    }

    if (summary.backend !== "tmux" || !summary.tmuxSession) {
      return {
        id,
        readiness: "unknown",
        sessionState: "running",
        reason: "non-tmux-session",
        observedAt: this.now(),
        activeProcess: summary.activeProcess ?? null,
        cwd: summary.cwd ?? null,
      };
    }

    const [activeProcess, cwd] = await Promise.all([
      tmuxPaneActiveProcess(summary.tmuxSession),
      tmuxPaneCurrentPath(summary.tmuxSession),
    ]);
    const isShellLike = activeProcess != null && /(?:^|\/)(?:sh|bash|zsh|fish|dash|ksh|tcsh|csh|nu)$/i.test(activeProcess);
    return {
      id,
      readiness: isShellLike ? "ready" : "busy",
      sessionState: isShellLike ? "idle" : "running",
      reason: isShellLike ? "shell-foreground" : "process-foreground",
      observedAt: this.now(),
      activeProcess,
      cwd: cwd ?? summary.cwd ?? null,
    };
  }

  async listWorktrees(): Promise<WorktreeSummary[]> {
    notImplemented("listWorktrees");
  }

  async createWorktree(_request: WorktreeCreateRequest): Promise<WorktreeSummary> {
    notImplemented("createWorktree");
  }

  async finishWorktree(_request: WorktreeFinishRequest): Promise<void> {
    notImplemented("finishWorktree");
  }

  async cleanupWorktree(_request: WorktreeCleanupRequest): Promise<void> {
    notImplemented("cleanupWorktree");
  }

  private spawnAttachedSession(args: {
    id?: string;
    name: string;
    sessionName: string;
    server: TmuxServer;
    cols?: number;
    rows?: number;
  }): PtySummary {
    return this.deps.ptys.spawn({
      id: args.id,
      name: args.name,
      backend: "tmux",
      tmuxSession: args.sessionName,
      command: "tmux",
      args: tmuxAttachArgs(args.sessionName, args.server),
      cols: args.cols ?? 120,
      rows: args.rows ?? 30,
    });
  }
}
