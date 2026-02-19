import Fastify from "fastify";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import { PtyManager } from "./pty/manager.js";
import { SqliteStore, type AgentSessionCwdSource, type AgentSessionRecord } from "./persist/sqlite.js";
import { ReadinessEngine, type PtyReadyEvent } from "./readiness/engine.js";
import type {
  ClientToServerMessage,
  PtySummary,
  ServerToClientMessage,
} from "./types.js";
import { WsHub } from "./ws/hub.js";
import { TriggerEngine } from "./triggers/engine.js";
import { TriggerLoader } from "./triggers/loader.js";
import { LogSessionDiscovery } from "./logSessions.js";
import {
  tmuxApplySessionUiOptions,
  tmuxCreateLinkedSession,
  tmuxCapturePaneVisible,
  tmuxCheckSessionConfig,
  tmuxCreateWindow,
  tmuxEnsureSession,
  tmuxIsLinkedViewSession,
  tmuxKillSession,
  tmuxKillWindow,
  tmuxListSessions,
  tmuxListWindows,
  tmuxLocateSession,
  tmuxTargetExists,
  tmuxPruneDetachedLinkedSessions,
  tmuxScrollHistory,
  tmuxTargetSession,
  type TmuxServer,
} from "./tmux.js";

import { execFileSync } from "node:child_process";
import {
  DEFAULT_WORKTREE_TEMPLATE,
  resolveWorktreePath,
  refreshWorktreeCacheSync,
  getWorktreeCache,
  worktreeFromCwd,
  projectRootFromCwd,
  isKnownWorktree,
  type WorktreeEntry,
} from "./worktree.js";

/** Resolve the top-level git repo root (handles running inside a worktree). */
const REPO_ROOT = (() => {
  try {
    // --git-common-dir returns the shared .git dir even from a worktree
    const gitCommon = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
    return path.dirname(gitCommon);
  } catch {
    return process.cwd();
  }
})();

const HOST = process.env.HOST ?? "127.0.0.1";
const DEFAULT_PORT = 4821;
const requestedPort = Number(process.env.PORT ?? String(DEFAULT_PORT));
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : DEFAULT_PORT;
const PUBLIC_DIR = path.resolve("public");
const DB_PATH = process.env.DB_PATH ?? path.resolve("data/agmux.db");
const TRIGGERS_PATH = process.env.TRIGGERS_PATH ?? path.resolve("triggers/index.js");
const AUTH_ENABLED = /^(1|true|yes|on)$/i.test((process.env.AGMUX_TOKEN_ENABLED ?? "").trim());
const AUTH_TOKEN = AUTH_ENABLED
  ? (process.env.AGMUX_TOKEN?.trim() || randomBytes(32).toString("hex"))
  : "";
const AUTH_TOKEN_SOURCE = !AUTH_ENABLED
  ? "disabled"
  : (process.env.AGMUX_TOKEN?.trim() ? "configured" : "generated");
const ALLOW_NON_LOOPBACK_BIND = process.env.AGMUX_ALLOW_NON_LOOPBACK === "1";
const LOG_LEVEL = (process.env.AGMUX_LOG_LEVEL?.trim() || "warn").toLowerCase();
const READINESS_TRACE_MAX = Math.max(100, Number(process.env.AGMUX_READINESS_TRACE_MAX ?? "2000") || 2000);
const READINESS_TRACE_LOG = process.env.AGMUX_READINESS_TRACE_LOG === "1";
const LOG_SESSION_DISCOVERY_ENABLED = process.env.AGMUX_LOG_SESSION_DISCOVERY !== "0";
const LOG_SESSION_SCAN_MAX = Math.max(1, Number(process.env.AGMUX_LOG_SESSION_SCAN_MAX ?? "500") || 500);
const LOG_SESSION_CACHE_MS = Math.max(
  250,
  Number(process.env.AGMUX_LOG_SESSION_CACHE_MS ?? "5000") || 5000,
);
const WS_ALLOWED_ORIGINS = new Set(
  [
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
    `http://[::1]:${PORT}`,
    ...(process.env.AGMUX_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0),
  ].map((v) => v.toLowerCase()),
);
const DEFAULT_BASE_BRANCH = "main";

const fastify = Fastify({
  logger: { level: LOG_LEVEL },
  disableRequestLogging: true,
});

const store = new SqliteStore(DB_PATH);
const ptys = new PtyManager();
const hub = new WsHub();
const logSessionDiscovery = new LogSessionDiscovery({
  enabled: LOG_SESSION_DISCOVERY_ENABLED,
  scanLimit: LOG_SESSION_SCAN_MAX,
  cacheMs: LOG_SESSION_CACHE_MS,
});
const triggerEngine = new TriggerEngine();
const triggerLoader = new TriggerLoader(TRIGGERS_PATH);

if (!ALLOW_NON_LOOPBACK_BIND && !isLoopbackHost(HOST)) {
  throw new Error(
    `Refusing to bind to non-loopback host "${HOST}". Set AGMUX_ALLOW_NON_LOOPBACK=1 to allow.`,
  );
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTokenFromAuthHeader(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(value.trim());
  if (!m) return null;
  const token = m[1].trim();
  return token.length > 0 ? token : null;
}

function parseTokenFromHeaders(headers: Record<string, unknown>): string | null {
  const direct = headers["x-agmux-token"];
  if (typeof direct === "string" && direct.length > 0) return direct;
  if (Array.isArray(direct)) {
    for (const v of direct) {
      if (typeof v === "string" && v.length > 0) return v;
    }
  }
  const auth = headers.authorization;
  if (Array.isArray(auth)) {
    for (const v of auth) {
      const token = parseTokenFromAuthHeader(v);
      if (token) return token;
    }
    return null;
  }
  return parseTokenFromAuthHeader(auth);
}

function parseTokenFromUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl, "http://localhost");
    const token = url.searchParams.get("token");
    return token && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function isTokenValid(headerToken: string | null, urlToken: string | null): boolean {
  if (!AUTH_ENABLED) return true;
  const token = headerToken ?? urlToken;
  return token != null && token === AUTH_TOKEN;
}

function requestNeedsToken(method: string, rawUrl: string | undefined): boolean {
  if (!AUTH_ENABLED) return false;
  if (method.toUpperCase() === "OPTIONS") return false;
  return (rawUrl ?? "").startsWith("/api/");
}

function isWsOriginAllowed(origin: string | undefined): boolean {
  if (!origin || origin.length === 0) return true;
  return WS_ALLOWED_ORIGINS.has(origin.toLowerCase());
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function pathExistsAndIsDirectory(target: string): Promise<boolean> {
  try {
    const st = await fs.stat(target);
    return st.isDirectory();
  } catch {
    return false;
  }
}

function isBranchFormatLikelySafe(branch: string): boolean {
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(branch)) return false;
  if (branch.startsWith("/") || branch.startsWith("-")) return false;
  if (branch.endsWith("/") || branch.endsWith(".")) return false;
  if (branch.includes("..") || branch.includes("//") || branch.includes("@{")) return false;
  if (branch.endsWith(".lock")) return false;
  return true;
}

async function gitBranchNameValid(branch: string, cwd: string = REPO_ROOT): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    execFile("git", ["check-ref-format", "--branch", branch], { cwd }, (err) => {
      resolve(!err);
    });
  });
}

async function gitRefExists(ref: string, cwd: string = REPO_ROOT): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    execFile("git", ["rev-parse", "--verify", "--quiet", ref], { cwd }, (err) => {
      resolve(!err);
    });
  });
}

async function resolveProjectRoot(raw: unknown): Promise<string | null> {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const resolved = path.resolve(raw.trim());
  if (!(await pathExistsAndIsDirectory(resolved))) return null;
  try {
    await fs.stat(path.join(resolved, ".git"));
    return resolved;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tmux reconciliation: tmux windows are the source of truth.
// Ensures exactly one running PTY attachment per agmux window.
// ---------------------------------------------------------------------------
const AGMUX_SESSION = "agmux";
let reconciling = false;

/** Track linked tmux sessions per PTY so we can clean them up on exit. */
const linkedSessionsByPty = new Map<string, { name: string; server: TmuxServer }>();
const agentSessionRefByPty = new Map<string, { provider: AgentProvider; providerSessionId: string }>();

type AgentProvider = "claude" | "codex" | "pi";
const AGENT_PROVIDER_SET = new Set<AgentProvider>(["claude", "codex", "pi"]);
const CWD_SOURCE_PRIORITY: Record<AgentSessionCwdSource, number> = {
  log: 1,
  db: 2,
  runtime: 3,
  user: 4,
};

type AgentSessionSummary = {
  id: string;
  provider: AgentProvider;
  providerSessionId: string;
  name: string;
  command: string;
  args: string[];
  cwd: string | null;
  cwdSource: AgentSessionCwdSource;
  projectRoot: string | null;
  worktree: string | null;
  createdAt: number;
  lastSeenAt: number;
  lastRestoredAt: number | null;
};

function normalizeAgentProvider(value: string | null | undefined): AgentProvider | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "claude" || v === "codex" || v === "pi") return v;
  return null;
}

function resumeArgsForProvider(provider: AgentProvider, providerSessionId: string): string[] {
  return provider === "claude" ? ["--resume", providerSessionId] : ["resume", providerSessionId];
}

function defaultAgentSessionName(provider: AgentProvider, providerSessionId: string, cwd: string | null): string {
  const leaf = cwd ? path.basename(cwd) : providerSessionId.slice(0, 8);
  return `${provider}:${leaf || providerSessionId.slice(0, 8) || "session"}`;
}

function agentSessionPublicId(provider: AgentProvider, providerSessionId: string): string {
  return `agent:${provider}:${providerSessionId}`;
}

function getWorktreeTemplate(): string {
  const settings = store.getPreference<{ worktreePathTemplate?: string }>("settings");
  return settings?.worktreePathTemplate || DEFAULT_WORKTREE_TEMPLATE;
}

function serverWorktreeFromCwd(cwd: string | null): string | null {
  return worktreeFromCwd(cwd, REPO_ROOT);
}

function serverProjectRootFromCwd(cwd: string | null): string | null {
  return projectRootFromCwd(cwd, REPO_ROOT);
}

function mergeAgentSessions(base: AgentSessionSummary, next: AgentSessionSummary): AgentSessionSummary {
  const chooseCwd =
    next.cwd != null &&
    (base.cwd == null ||
      CWD_SOURCE_PRIORITY[next.cwdSource] > CWD_SOURCE_PRIORITY[base.cwdSource] ||
      (CWD_SOURCE_PRIORITY[next.cwdSource] === CWD_SOURCE_PRIORITY[base.cwdSource] &&
        next.lastSeenAt > base.lastSeenAt));

  const cwd = chooseCwd ? next.cwd : base.cwd;
  const cwdSource = chooseCwd ? next.cwdSource : base.cwdSource;
  const newer = next.lastSeenAt >= base.lastSeenAt ? next : base;

  return {
    id: agentSessionPublicId(base.provider, base.providerSessionId),
    provider: base.provider,
    providerSessionId: base.providerSessionId,
    name: newer.name,
    command: newer.command,
    args: newer.args,
    cwd,
    cwdSource,
    projectRoot: serverProjectRootFromCwd(cwd),
    worktree: serverWorktreeFromCwd(cwd),
    createdAt: Math.min(base.createdAt, next.createdAt),
    lastSeenAt: Math.max(base.lastSeenAt, next.lastSeenAt),
    lastRestoredAt: Math.max(base.lastRestoredAt ?? 0, next.lastRestoredAt ?? 0) || null,
  };
}

function parseProviderSessionIdFromLog(summary: PtySummary): string | null {
  const parsed = summary.id.match(/^log:(?:claude|codex|pi):(.+)$/);
  if (parsed && parsed[1]?.trim()) return parsed[1].trim();
  const lastArg = summary.args.length > 0 ? summary.args[summary.args.length - 1] : "";
  const normalized = typeof lastArg === "string" ? lastArg.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

function toAgentSessionFromLog(summary: PtySummary): AgentSessionSummary | null {
  const fromId = /^log:(claude|codex|pi):/.exec(summary.id)?.[1] ?? null;
  const provider = normalizeAgentProvider(fromId ?? summary.command);
  if (!provider) return null;
  const providerSessionId = parseProviderSessionIdFromLog(summary);
  if (!providerSessionId) return null;
  const cwd = summary.cwd ?? null;
  return {
    id: agentSessionPublicId(provider, providerSessionId),
    provider,
    providerSessionId,
    name: summary.name || defaultAgentSessionName(provider, providerSessionId, cwd),
    command: provider,
    args: resumeArgsForProvider(provider, providerSessionId),
    cwd,
    cwdSource: "log",
    projectRoot: serverProjectRootFromCwd(cwd),
    worktree: serverWorktreeFromCwd(cwd),
    createdAt: summary.createdAt,
    lastSeenAt: summary.lastSeenAt ?? summary.createdAt,
    lastRestoredAt: null,
  };
}

function toAgentSessionFromRecord(record: AgentSessionRecord): AgentSessionSummary | null {
  const provider = normalizeAgentProvider(record.provider);
  if (!provider) return null;
  const providerSessionId = record.providerSessionId.trim();
  if (!providerSessionId) return null;
  const cwd = record.cwd ?? null;
  const fallbackName = defaultAgentSessionName(provider, providerSessionId, cwd);
  return {
    id: agentSessionPublicId(provider, providerSessionId),
    provider,
    providerSessionId,
    name: record.name || fallbackName,
    command: record.command || provider,
    args: record.args.length > 0 ? record.args : resumeArgsForProvider(provider, providerSessionId),
    cwd,
    cwdSource: record.cwdSource,
    projectRoot: serverProjectRootFromCwd(cwd),
    worktree: serverWorktreeFromCwd(cwd),
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    lastRestoredAt: record.lastRestoredAt ?? null,
  };
}

function toAgentSessionFromLegacySessionRow(summary: PtySummary): AgentSessionSummary | null {
  const fromId = /^log:(claude|codex|pi):/.exec(summary.id)?.[1] ?? null;
  const provider = normalizeAgentProvider(fromId ?? summary.command);
  if (!provider) return null;
  const providerSessionId = parseProviderSessionIdFromLog(summary);
  if (!providerSessionId) return null;
  const cwd = summary.cwd ?? null;
  return {
    id: agentSessionPublicId(provider, providerSessionId),
    provider,
    providerSessionId,
    name: summary.name || defaultAgentSessionName(provider, providerSessionId, cwd),
    command: provider,
    args: resumeArgsForProvider(provider, providerSessionId),
    cwd,
    cwdSource: "db",
    projectRoot: serverProjectRootFromCwd(cwd),
    worktree: serverWorktreeFromCwd(cwd),
    createdAt: summary.createdAt,
    lastSeenAt: summary.lastSeenAt ?? summary.createdAt,
    lastRestoredAt: null,
  };
}

function upsertAgentSessionSummary(summary: AgentSessionSummary): void {
  store.upsertAgentSession({
    provider: summary.provider,
    providerSessionId: summary.providerSessionId,
    name: summary.name,
    command: summary.command,
    args: summary.args,
    cwd: summary.cwd,
    cwdSource: summary.cwdSource,
    createdAt: summary.createdAt,
    lastSeenAt: summary.lastSeenAt,
    lastRestoredAt: summary.lastRestoredAt,
  });
}

function listAgentSessions(): AgentSessionSummary[] {
  const merged = new Map<string, AgentSessionSummary>();
  const dbRows = store.listAgentSessions().map(toAgentSessionFromRecord).filter((x): x is AgentSessionSummary => x != null);
  const legacyRows = store.listSessions(800).map(toAgentSessionFromLegacySessionRow).filter((x): x is AgentSessionSummary => x != null);
  const discovered = logSessionDiscovery.list().map(toAgentSessionFromLog).filter((x): x is AgentSessionSummary => x != null);

  for (const session of [...dbRows, ...legacyRows, ...discovered]) {
    const key = `${session.provider}:${session.providerSessionId}`;
    const prev = merged.get(key);
    merged.set(key, prev ? mergeAgentSessions(prev, session) : session);
  }
  return [...merged.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

function findAgentSessionSummary(provider: AgentProvider, providerSessionId: string): AgentSessionSummary | null {
  const wantedKey = `${provider}:${providerSessionId}`;
  for (const session of listAgentSessions()) {
    if (`${session.provider}:${session.providerSessionId}` === wantedKey) return session;
  }
  return null;
}

function persistRuntimeCwdForAgentPty(ptyId: string, cwd: string | null | undefined, ts: number): void {
  const ref = agentSessionRefByPty.get(ptyId);
  if (!ref) return;
  const persisted = store.getAgentSession(ref.provider, ref.providerSessionId);
  const normalizedCwd = typeof cwd === "string" && cwd.trim().length > 0 ? cwd.trim() : null;
  const effectiveCwd = normalizedCwd ?? persisted?.cwd ?? null;
  const merged: AgentSessionSummary = {
    id: agentSessionPublicId(ref.provider, ref.providerSessionId),
    provider: ref.provider,
    providerSessionId: ref.providerSessionId,
    name: persisted?.name ?? defaultAgentSessionName(ref.provider, ref.providerSessionId, effectiveCwd),
    command: persisted?.command ?? ref.provider,
    args: persisted?.args ?? resumeArgsForProvider(ref.provider, ref.providerSessionId),
    cwd: effectiveCwd,
    cwdSource: normalizedCwd ? "runtime" : (persisted?.cwdSource ?? "db"),
    projectRoot: serverProjectRootFromCwd(effectiveCwd),
    worktree: serverWorktreeFromCwd(effectiveCwd),
    createdAt: persisted?.createdAt ?? ts,
    lastSeenAt: ts,
    lastRestoredAt: persisted?.lastRestoredAt ?? null,
  };
  upsertAgentSessionSummary(merged);
}

async function reconcileTmuxAttachments(): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  try {
    const windows = await tmuxListWindows(AGMUX_SESSION);
    const windowTargets = new Set(windows.map((w) => w.target));

    // Map target → ptyId for running agmux PTYs.
    const runningByTarget = new Map<string, string>();
    for (const p of ptys.list()) {
      if (
        p.status === "running" &&
        p.tmuxSession &&
        p.tmuxServer !== "default" &&
        tmuxTargetSession(p.tmuxSession) === AGMUX_SESSION
      ) {
        if (runningByTarget.has(p.tmuxSession)) {
          // Duplicate! Kill the newer one.
          ptys.kill(p.id);
          fastify.log.info({ ptyId: p.id, tmuxSession: p.tmuxSession }, "killed duplicate PTY for same window");
          continue;
        }
        runningByTarget.set(p.tmuxSession, p.id);
      }
    }

    // Spawn attachments for orphaned windows (window exists, no PTY).
    const shell = process.env.AGMUX_SHELL ?? process.env.SHELL ?? "bash";
    for (const w of windows) {
      if (!runningByTarget.has(w.target)) {
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
        fastify.log.info({ ptyId: summary.id, tmuxSession: w.target }, "reconcile: attached orphaned window");
      }
    }

    // Kill PTYs whose target window no longer exists.
    for (const [target, ptyId] of runningByTarget) {
      if (!windowTargets.has(target)) {
        ptys.kill(ptyId);
        fastify.log.info({ ptyId, tmuxSession: target }, "reconcile: killed PTY for missing window");
      }
    }
  } finally {
    reconciling = false;
  }
}

type ReadinessTraceEntry = PtyReadyEvent & { seq: number };
const readinessTrace: ReadinessTraceEntry[] = [];
let readinessTraceSeq = 0;

function recordReadinessTrace(evt: PtyReadyEvent): void {
  readinessTrace.push({ ...evt, seq: readinessTraceSeq++ });
  if (readinessTrace.length > READINESS_TRACE_MAX) {
    readinessTrace.splice(0, readinessTrace.length - READINESS_TRACE_MAX);
  }
  if (READINESS_TRACE_LOG) {
    fastify.log.info(
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


const readinessEngine = new ReadinessEngine({
  ptys,
  emitReadiness: ({ ptyId, state, indicator, reason, ts, cwd, source, activeProcess }) => {
    persistRuntimeCwdForAgentPty(ptyId, cwd, ts);
    recordReadinessTrace({ ptyId, state, indicator, reason, source, ts, cwd, activeProcess });
    broadcast({ type: "pty_ready", ptyId, state, indicator, reason, ts, cwd, activeProcess });
  },
});

async function listPtys(): Promise<PtySummary[]> {
  return readinessEngine.withActiveProcesses(ptys.list());
}

function findKnownSessionSummary(id: string): PtySummary | null {
  const live = ptys.getSummary(id);
  if (live) return live;
  return null;
}

async function broadcastPtyList(): Promise<void> {
  broadcast({ type: "pty_list", ptys: await listPtys() });
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

async function loadTriggersAndBroadcast(reason: string): Promise<void> {
  try {
    const { triggers, version } = await triggerLoader.load();
    triggerEngine.setTriggers(triggers);
    fastify.log.info({ reason, version, count: triggers.length }, "Triggers loaded");
  } catch (err) {
    // Keep last-known-good triggers.
    triggerEngine.setTriggers(triggerLoader.lastGoodTriggers());
    const message = err instanceof Error ? err.message : String(err);
    fastify.log.error({ err: message }, "Trigger reload failed");
    broadcast({
      type: "trigger_error",
      ptyId: "system",
      trigger: "reload",
      ts: Date.now(),
      message,
    });
  }
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

function stripAlternateScreenSequences(s: string): string {
  // Many CLIs (and tmux itself) use the alternate screen, which disables scrollback in xterm.js.
  // This mirrors a common terminal setting ("disable alternate screen") by stripping the control
  // sequences that switch buffers.
  return s
    .replaceAll("\x1b[?1049h", "")
    .replaceAll("\x1b[?1049l", "")
    .replaceAll("\x1b[?47h", "")
    .replaceAll("\x1b[?47l", "")
    .replaceAll("\x1b[?1047h", "")
    .replaceAll("\x1b[?1047l", "");
}

ptys.on("exit", (ptyId: string, code: number | null, signal: string | null) => {
  const summary = ptys.getSummary(ptyId);
  if (summary) store.upsertSession(summary);
  readinessEngine.markExited(ptyId);
  agentSessionRefByPty.delete(ptyId);
  fastify.log.info({ ptyId, code, signal }, "pty exited");
  broadcast({ type: "pty_exit", ptyId, code, signal });

  // Clean up the linked tmux session for this PTY.
  const linked = linkedSessionsByPty.get(ptyId);
  if (linked) {
    linkedSessionsByPty.delete(ptyId);
    tmuxKillSession(linked.name, linked.server).catch(() => {});
  }

  // Reconcile after a brief delay to reattach if the window still exists
  // (or clean up if it doesn't).
  if (summary?.tmuxSession && summary.tmuxServer !== "default") {
    void (async () => {
      // Small delay to avoid tight loops if tmux is unstable.
      await new Promise((r) => setTimeout(r, 250));
      await reconcileTmuxAttachments();
      await broadcastPtyList();
    })();
  }
});

// REST API
fastify.addHook("onRequest", async (req, reply) => {
  if (!requestNeedsToken(req.raw.method ?? "GET", req.raw.url)) return;
  const headerToken = parseTokenFromHeaders(req.headers as unknown as Record<string, unknown>);
  const urlToken = parseTokenFromUrl(req.raw.url);
  if (isTokenValid(headerToken, urlToken)) return;
  reply.code(401);
  return { error: "missing or invalid auth token" };
});

fastify.get("/api/ptys", async () => {
  return { ptys: await listPtys() };
});

fastify.get("/api/agent-sessions", async () => {
  return { sessions: listAgentSessions() };
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

  const session = findAgentSessionSummary(provider, providerSessionId);
  if (!session) {
    reply.code(404);
    return { error: "unknown agent session" };
  }

  const body = isRecord(req.body) ? req.body : {};
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
    if (!isKnownWorktree(resolved, REPO_ROOT)) {
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
    if (!/^[A-Za-z0-9._/-]+$/.test(rawBranch)) {
      reply.code(400);
      return { error: "branch contains invalid characters" };
    }
    const wtPath = resolveWorktreePath(REPO_ROOT, rawBranch, getWorktreeTemplate());
    try {
      await fs.mkdir(path.dirname(wtPath), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        execFile("git", ["worktree", "add", wtPath, "-b", rawBranch], { cwd: REPO_ROOT }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.code(409);
      return { error: message };
    }
    refreshWorktreeCacheSync(REPO_ROOT);
    cwd = wtPath;
    cwdSource = "user";
  }

  if (!cwd) cwd = REPO_ROOT;

  try {
    // Use tmux so the agent process survives server restarts.
    const shell = process.env.AGMUX_SHELL ?? process.env.SHELL ?? "bash";
    const SESSION_NAME = "agmux";
    await tmuxEnsureSession(SESSION_NAME, shell);
    const tmuxTarget = await tmuxCreateWindow(SESSION_NAME, shell, cwd);
    const { linkedSession, attachArgs } = await tmuxCreateLinkedSession(tmuxTarget);

    const summary = ptys.spawn({
      name: session.name,
      backend: "tmux",
      tmuxSession: tmuxTarget,
      tmuxServer: "agmux",
      command: "tmux",
      args: attachArgs,
      cols: 120,
      rows: 30,
    });
    linkedSessionsByPty.set(summary.id, { name: linkedSession, server: "agmux" });
    const now = Date.now();
    store.upsertSession(summary);
    agentSessionRefByPty.set(summary.id, { provider, providerSessionId });

    // Type the resume command into the tmux shell after a short delay.
    const resumeArgs = resumeArgsForProvider(provider, providerSessionId);
    setTimeout(() => {
      const cmd = `unset CLAUDECODE; ${provider} ${resumeArgs.join(" ")}`;
      ptys.write(summary.id, `${cmd}\n`);
    }, 300);

    upsertAgentSessionSummary({
      ...session,
      id: agentSessionPublicId(provider, providerSessionId),
      command: provider,
      args: resumeArgs,
      cwd: cwd ?? null,
      cwdSource,
      projectRoot: serverProjectRootFromCwd(cwd ?? null),
      worktree: serverWorktreeFromCwd(cwd ?? null),
      lastSeenAt: Math.max(session.lastSeenAt, now),
      lastRestoredAt: now,
    });
    fastify.log.info(
      { ptyId: summary.id, provider, providerSessionId, cwd: cwd ?? null, target, tmuxSession: tmuxTarget },
      "agent session restored (tmux)",
    );
    await broadcastPtyList();
    return { id: summary.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reply.code(500);
    return { error: message };
  }
});

fastify.get("/api/readiness/trace", async (req) => {
  const q = req.query as Record<string, unknown>;
  const ptyId = typeof q.ptyId === "string" && q.ptyId.trim().length > 0 ? q.ptyId.trim() : null;
  const parsedLimit = Number(q.limit);
  const limit = Number.isInteger(parsedLimit) ? Math.max(1, Math.min(2000, parsedLimit)) : 200;
  const filtered = ptyId ? readinessTrace.filter((evt) => evt.ptyId === ptyId) : readinessTrace;
  return { events: filtered.slice(-limit) };
});

fastify.get("/api/tmux/sessions", async () => {
  const sessions = (await tmuxListSessions())
    .filter((s) => !(s.server === "agmux" && tmuxIsLinkedViewSession(s.name, AGMUX_SESSION)));
  return { sessions };
});

fastify.get("/api/tmux/check", async (req, reply) => {
  const q = req.query as Record<string, unknown>;
  const name = typeof q.name === "string" ? q.name.trim() : "";
  const serverRaw = typeof q.server === "string" ? q.server : "";
  if (!name) {
    reply.code(400);
    return { error: "name is required" };
  }
  if (serverRaw !== "agmux" && serverRaw !== "default") {
    reply.code(400);
    return { error: "server must be agmux or default" };
  }
  const requestedServer: TmuxServer = serverRaw;
  const located = await tmuxLocateSession(name, requestedServer);
  if (located !== requestedServer) {
    reply.code(404);
    return { error: "tmux session not found on requested server" };
  }
  const checks = await tmuxCheckSessionConfig(name, requestedServer);
  return { checks };
});

// Create an interactive login shell with zero UI configuration.
fastify.get("/api/directory-exists", async (req, reply) => {
  const q = req.query as Record<string, unknown>;
  const rawPath = typeof q.path === "string" ? q.path.trim() : "";
  if (!rawPath) {
    reply.code(400);
    return { error: "path is required" };
  }
  const resolved = path.resolve(rawPath);
  const exists = await pathExistsAndIsDirectory(resolved);
  return { exists };
});

fastify.get("/api/worktrees", async () => {
  refreshWorktreeCacheSync(REPO_ROOT);
  const cache = getWorktreeCache(REPO_ROOT);
  const worktrees: { name: string; path: string; branch: string }[] = [];
  for (const entry of cache) {
    if (entry.path === REPO_ROOT) continue;
    worktrees.push({
      name: entry.branch || path.basename(entry.path),
      path: entry.path,
      branch: entry.branch,
    });
  }
  return { worktrees, repoRoot: REPO_ROOT };
});

fastify.get("/api/default-branch", async (req) => {
  const q = req.query as Record<string, unknown>;
  const projectRoot = await resolveProjectRoot(q.projectRoot);
  const cwd = projectRoot ?? REPO_ROOT;
  // Try symbolic-ref first (remote HEAD)
  try {
    const ref = await new Promise<string>((resolve, reject) => {
      execFile("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
    });
    // ref looks like "refs/remotes/origin/main"
    const branch = ref.replace(/^refs\/remotes\/origin\//, "");
    if (branch) return { branch };
  } catch {
    // fall through
  }
  // Fallback: check if main or master exists
  for (const candidate of ["main", "master"]) {
    if (await gitRefExists(candidate, cwd)) return { branch: candidate };
  }
  return { branch: "main" };
});

fastify.get("/api/worktrees/status", async (req, reply) => {
  const q = req.query as Record<string, unknown>;
  const wtPath = typeof q.path === "string" ? q.path.trim() : "";
  if (!wtPath) {
    reply.code(400);
    return { error: "path is required" };
  }
  const resolved = path.resolve(wtPath);
  if (!isKnownWorktree(resolved, REPO_ROOT)) {
    reply.code(400);
    return { error: "path is not a known worktree" };
  }
  try {
    const result = await new Promise<string>((resolve, reject) => {
      execFile("git", ["status", "--porcelain"], { cwd: resolved }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
    const dirty = result.trim().length > 0;
    let branch = "";
    try {
      branch = await new Promise<string>((resolve, reject) => {
        execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: resolved }, (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout.trim());
        });
      });
    } catch {
      // ignore
    }
    return { dirty, branch };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reply.code(500);
    return { error: message };
  }
});

fastify.delete("/api/worktrees", async (req, reply) => {
  const body = isRecord(req.body) ? req.body : {};
  const wtPath = typeof body.path === "string" ? body.path.trim() : "";
  if (!wtPath) {
    reply.code(400);
    return { error: "path is required" };
  }
  const resolved = path.resolve(wtPath);
  if (!isKnownWorktree(resolved, REPO_ROOT)) {
    reply.code(400);
    return { error: "path is not a known worktree" };
  }

  // Check for uncommitted changes
  try {
    const statusResult = await new Promise<string>((resolve, reject) => {
      execFile("git", ["status", "--porcelain"], { cwd: resolved }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
    if (statusResult.trim().length > 0) {
      // Force remove even with dirty state (user confirmed in modal)
      await new Promise<void>((resolve, reject) => {
        execFile("git", ["worktree", "remove", "--force", resolved], { cwd: REPO_ROOT }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } else {
      await new Promise<void>((resolve, reject) => {
        execFile("git", ["worktree", "remove", resolved], { cwd: REPO_ROOT }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reply.code(500);
    return { error: message };
  }

  // Prune stale worktree references
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("git", ["worktree", "prune"], { cwd: REPO_ROOT }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } catch {
    // ignore prune failures
  }

  refreshWorktreeCacheSync(REPO_ROOT);
  return { ok: true };
});

/** Select values that match CLI defaults and should not be emitted. */
const FLAG_DEFAULTS: Record<string, Record<string, string>> = {
  claude: { "--permission-mode": "default" },
  codex: { "--ask-for-approval": "untrusted", "--sandbox": "read-only" },
};

/** Build the CLI command from agent name + flag values from the UI. */
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

fastify.post("/api/ptys/launch", async (req, reply) => {
  const body = isRecord(req.body) ? req.body : {};
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

  const projectRoot = await resolveProjectRoot(body.projectRoot);
  if (body.projectRoot && !projectRoot) {
    reply.code(400);
    return { error: `project directory not found: ${body.projectRoot}` };
  }
  const effectiveRepoRoot = projectRoot ?? REPO_ROOT;

  let cwd: string;
  if (worktree === "__new__") {
    const branch = typeof body.branch === "string" && body.branch.trim()
      ? body.branch.trim()
      : `wt-${Date.now()}`;
    const baseBranch = typeof body.baseBranch === "string" && body.baseBranch.trim().length > 0
      ? body.baseBranch.trim()
      : DEFAULT_BASE_BRANCH;
    if (!isBranchFormatLikelySafe(branch) || !(await gitBranchNameValid(branch, effectiveRepoRoot))) {
      reply.code(400);
      return { error: "invalid branch name" };
    }
    if (!isBranchFormatLikelySafe(baseBranch)) {
      reply.code(400);
      return { error: "invalid base branch" };
    }
    if (!(await gitRefExists(`${baseBranch}^{commit}`, effectiveRepoRoot))) {
      reply.code(400);
      return { error: `base branch not found: ${baseBranch}` };
    }

    const wtPath = resolveWorktreePath(effectiveRepoRoot, branch, getWorktreeTemplate());

    await fs.mkdir(path.dirname(wtPath), { recursive: true });

    const branchExists = await gitRefExists(`refs/heads/${branch}`, effectiveRepoRoot);
    if (branchExists) {
      await new Promise<void>((resolve, reject) => {
        execFile("git", ["worktree", "add", wtPath, branch], { cwd: effectiveRepoRoot }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } else {
      await new Promise<void>((resolve, reject) => {
        execFile("git", ["worktree", "add", "-b", branch, wtPath, baseBranch], { cwd: effectiveRepoRoot }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
    refreshWorktreeCacheSync(effectiveRepoRoot);
    cwd = wtPath;
  } else {
    const resolved = path.resolve(worktree);
    if (!(await pathExistsAndIsDirectory(resolved))) {
      reply.code(400);
      return { error: "worktree path does not exist or is not a directory" };
    }
    cwd = resolved;
  }

  // Create shell using tmux (reuse /api/ptys/shell logic)
  const shell = process.env.AGMUX_SHELL ?? process.env.SHELL ?? "bash";
  const SESSION_NAME = "agmux";
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

  // Create a new tmux window with the worktree as cwd
  const tmuxTarget = await tmuxCreateWindow(SESSION_NAME, shell, cwd);
  const { linkedSession, attachArgs } = await tmuxCreateLinkedSession(tmuxTarget);

  const name = `shell:${path.basename(shell)}`;
  const summary = ptys.spawn({
    name,
    backend: "tmux",
    tmuxSession: tmuxTarget,
    tmuxServer: "agmux",
    command: "tmux",
    args: attachArgs,
    cols: 120,
    rows: 30,
  });
  linkedSessionsByPty.set(summary.id, { name: linkedSession, server: "agmux" });
  store.upsertSession(summary);
  fastify.log.info({ ptyId: summary.id, agent, cwd, tmuxSession: tmuxTarget }, "launch: shell spawned");
  await broadcastPtyList();

  // Write the agent launch command into the PTY after a short delay
  // Skip for "shell" — the user just wants a plain terminal
  if (agent !== "shell") {
    const flags = isRecord(body.flags) ? body.flags as Record<string, string | boolean> : {};
    setTimeout(() => {
      // Unset CLAUDECODE so nested Claude Code sessions don't refuse to start
      const cmd = agentCommand(agent, flags);
      ptys.write(summary.id, `unset CLAUDECODE; ${cmd}\n`);
    }, 300);
  }

  // Remember the user's launch preferences (per-agent flags)
  const agentFlags = isRecord(body.flags) ? body.flags : {};
  const prev = store.getPreference<{ agent?: string; flags?: Record<string, unknown> }>("launch") ?? {};
  const allFlags = { ...(prev.flags ?? {}), [agent]: agentFlags };
  store.setPreference("launch", { agent, flags: allFlags });

  return { id: summary.id };
});

fastify.get("/api/launch-preferences", async () => {
  return store.getPreference("launch") ?? {};
});

fastify.get("/api/settings", async () => {
  return store.getPreference("settings") ?? {};
});

fastify.put("/api/settings", async (req) => {
  const body = isRecord(req.body) ? req.body : {};
  const prev = store.getPreference<Record<string, unknown>>("settings") ?? {};
  const merged = { ...prev, ...body };
  // Remove null keys
  for (const [k, v] of Object.entries(merged)) {
    if (v === null) delete merged[k];
  }
  store.setPreference("settings", merged);
  return merged;
});

fastify.post("/api/ptys/shell", async (_req, reply) => {
  const shell = process.env.AGMUX_SHELL ?? process.env.SHELL ?? "bash";

  // Use a single tmux session with one window per shell.
  try {
    await tmuxEnsureSession(AGMUX_SESSION, shell);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("shell must")) {
      reply.code(400);
      return { error: message };
    }
    throw err;
  }

  // Reuse an unattached window (e.g. from session creation) or create a new one.
  const windows = await tmuxListWindows(AGMUX_SESSION);
  const attachedTargets = new Set(
    ptys.list()
      .filter((p) => p.tmuxSession && p.tmuxServer !== "default")
      .map((p) => p.tmuxSession),
  );
  let tmuxTarget: string | null = null;
  for (const w of windows) {
    if (!attachedTargets.has(w.target)) {
      tmuxTarget = w.target;
      break;
    }
  }
  if (!tmuxTarget) {
    tmuxTarget = await tmuxCreateWindow(AGMUX_SESSION, shell);
  }
  const { linkedSession, attachArgs } = await tmuxCreateLinkedSession(tmuxTarget);
  const name = `shell:${path.basename(shell)}`;
  const summary = ptys.spawn({
    name,
    backend: "tmux",
    tmuxSession: tmuxTarget,
    tmuxServer: "agmux",
    command: "tmux",
    args: attachArgs,
    cols: 120,
    rows: 30,
  });
  linkedSessionsByPty.set(summary.id, { name: linkedSession, server: "agmux" });
  store.upsertSession(summary);
  fastify.log.info({ ptyId: summary.id, shell, tmuxSession: tmuxTarget }, "shell spawned");
  await broadcastPtyList();
  return { id: summary.id };
});

fastify.post("/api/ptys/attach-tmux", async (req, reply) => {
  const body = isRecord(req.body) ? req.body : {};
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
  if (located === "agmux" && tmuxIsLinkedViewSession(name, AGMUX_SESSION)) {
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
  const summary = ptys.spawn({
    name: `tmux:${name}`,
    backend: "tmux",
    tmuxSession: name,
    tmuxServer: server,
    command: "tmux",
    args: attachArgs,
    cols: 120,
    rows: 30,
  });
  linkedSessionsByPty.set(summary.id, { name: linkedSession, server });
  store.upsertSession(summary);
  await broadcastPtyList();
  return { id: summary.id };
});

fastify.post("/api/ptys/:id/kill", async (req, reply) => {
  const id = (req.params as any).id as string;
  const summary = findKnownSessionSummary(id);
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
  ptys.kill(id);
  fastify.log.info({ ptyId: id }, "pty killed");

  // If there is no live PTY process (e.g. server restarted but didn't attach yet),
  // ensure metadata reflects the kill immediately.
  const after = ptys.getSummary(id) ?? summary;
  after.status = "exited";
  after.exitCode = after.exitCode ?? null;
  after.exitSignal = after.exitSignal ?? null;
  store.upsertSession(after);
  readinessEngine.markExited(id);
  await broadcastPtyList();
  return { ok: true };
});

fastify.post("/api/ptys/:id/resume", async (req, reply) => {
  const id = (req.params as any).id as string;
  const live = ptys.getSummary(id);
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

fastify.put("/api/ptys/:id/input-history", async (req, reply) => {
  const id = (req.params as any).id as string;
  const body = isRecord(req.body) ? req.body : {};
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

fastify.post("/api/triggers/reload", async () => {
  await loadTriggersAndBroadcast("manual");
  return { ok: true };
});

async function restoreAtStartup(): Promise<void> {
  // Initialize worktree cache early so all functions can use it.
  refreshWorktreeCacheSync(REPO_ROOT);

  // Ensure the single agmux tmux session exists (creates it if missing).
  const shell = process.env.AGMUX_SHELL ?? process.env.SHELL ?? "bash";
  await tmuxEnsureSession(AGMUX_SESSION, shell);
  const pruned = await tmuxPruneDetachedLinkedSessions(AGMUX_SESSION);
  if (pruned.length > 0) {
    fastify.log.info({ count: pruned.length }, "pruned stale linked tmux sessions");
  }
  // Reconcile agmux tmux windows — any existing window gets an attachment
  // PTY; stale PTYs are cleaned up.
  await reconcileTmuxAttachments();
}

// Minimal static serving from /public
async function serveStatic(
  rel: string,
): Promise<{ data: Buffer; type: string; etag: string; lastModified: string } | null> {
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) return null;
  let st: Awaited<ReturnType<typeof fs.stat>>;
  try {
    st = await fs.stat(filePath);
    if (!st.isFile()) return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
  let data: Buffer;
  try {
    data = await fs.readFile(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return null;
    throw err;
  }
  const ext = path.extname(filePath).toLowerCase();
  const type =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".css"
        ? "text/css; charset=utf-8"
        : ext === ".js"
          ? "text/javascript; charset=utf-8"
          : ext === ".map"
            ? "application/json; charset=utf-8"
            : "application/octet-stream";
  // Weak ETag is enough for dev reload polling and avoids heavy hashing.
  const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
  const lastModified = st.mtime.toUTCString();
  return { data, type, etag, lastModified };
}

fastify.get("/", async (_req, reply) => {
  const r = await serveStatic("index.html");
  if (!r) return reply.code(404).send("not found");
  // This UI is primarily used in a live-edit loop; keep it uncacheable.
  reply.header("Cache-Control", "no-store");
  reply.header("ETag", r.etag);
  reply.header("Last-Modified", r.lastModified);
  return reply.type(r.type).send(r.data);
});

fastify.get("/:file", async (req, reply) => {
  const file = (req.params as any).file as string;
  if (file.startsWith("api")) return reply.code(404).send("not found");
  const r = await serveStatic(file);
  if (!r) return reply.code(404).send("not found");

  // This UI is primarily used in a live-edit loop; keep it uncacheable.
  reply.header("Cache-Control", "no-store");
  reply.header("ETag", r.etag);
  reply.header("Last-Modified", r.lastModified);

  const inm = req.headers["if-none-match"];
  if (typeof inm === "string" && inm === r.etag) return reply.code(304).send();

  return reply.type(r.type).send(r.data);
});

// WS upgrade on /ws
const wss = new WebSocketServer({ noServer: true });

function send(ws: WebSocket, msg: ServerToClientMessage): void {
  ws.send(JSON.stringify(msg));
}

function parseWsMessage(raw: unknown): ClientToServerMessage | null {
  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    text = raw.toString("utf8");
  } else if (Array.isArray(raw) && raw.every(Buffer.isBuffer)) {
    text = Buffer.concat(raw).toString("utf8");
  } else if (raw instanceof ArrayBuffer) {
    text = Buffer.from(raw).toString("utf8");
  } else {
    return null;
  }

  if (Buffer.byteLength(text, "utf8") > 256 * 1024) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  if (parsed.type === "subscribe") {
    if (typeof parsed.ptyId !== "string" || parsed.ptyId.length === 0) return null;
    return { type: "subscribe", ptyId: parsed.ptyId };
  }
  if (parsed.type === "input") {
    if (typeof parsed.ptyId !== "string" || parsed.ptyId.length === 0) return null;
    if (typeof parsed.data !== "string") return null;
    if (Buffer.byteLength(parsed.data, "utf8") > 64 * 1024) return null;
    return { type: "input", ptyId: parsed.ptyId, data: parsed.data };
  }
  if (parsed.type === "resize") {
    if (typeof parsed.ptyId !== "string" || parsed.ptyId.length === 0) return null;
    const cols = parsed.cols;
    const rows = parsed.rows;
    if (typeof cols !== "number" || typeof rows !== "number") return null;
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
    if (cols < 1 || cols > 1000) return null;
    if (rows < 1 || rows > 1000) return null;
    return {
      type: "resize",
      ptyId: parsed.ptyId,
      cols,
      rows,
    };
  }
  if (parsed.type === "tmux_control") {
    if (typeof parsed.ptyId !== "string" || parsed.ptyId.length === 0) return null;
    const direction = parsed.direction;
    const lines = parsed.lines;
    if (direction !== "up" && direction !== "down") return null;
    if (typeof lines !== "number" || !Number.isInteger(lines)) return null;
    if (lines < 1 || lines > 200) return null;
    return {
      type: "tmux_control",
      ptyId: parsed.ptyId,
      direction,
      lines,
    };
  }
  return null;
}

wss.on("connection", (ws) => {
  const client = hub.add(ws);

  // Initial list.
  void listPtys()
    .then((items) => send(ws, { type: "pty_list", ptys: items }))
    .catch(() => send(ws, { type: "pty_list", ptys: ptys.list() }));

  ws.on("message", (raw) => {
    const msg = parseWsMessage(raw);
    if (!msg) return;

    if (msg.type === "subscribe") {
      client.subscribed.add(msg.ptyId);
      const summary = ptys.getSummary(msg.ptyId);
      if (summary?.tmuxSession) {
        void tmuxCapturePaneVisible(summary.tmuxSession, summary.tmuxServer)
          .then((snapshot) => {
            if (!snapshot || ws.readyState !== ws.OPEN) return;
            send(ws, {
              type: "pty_output",
              ptyId: msg.ptyId,
              data: snapshot.endsWith("\n") ? snapshot : `${snapshot}\n`,
            });
          })
          .catch(() => {
            // ignore best-effort snapshot for tmux attach
          });
      }
      return;
    }
    if (msg.type === "input") {
      readinessEngine.markInput(msg.ptyId, msg.data);
      ptys.write(msg.ptyId, msg.data);
      return;
    }
    if (msg.type === "resize") {
      ptys.resize(msg.ptyId, msg.cols, msg.rows);
      return;
    }
    if (msg.type === "tmux_control") {
      const summary = ptys.getSummary(msg.ptyId);
      if (!summary || !summary.tmuxSession) return;
      void tmuxScrollHistory(summary.tmuxSession, msg.direction, msg.lines, summary.tmuxServer).catch(() => {
        // ignore best-effort tmux history control
      });
      return;
    }
  });
});

fastify.server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    if (!isWsOriginAllowed(req.headers.origin)) {
      socket.destroy();
      return;
    }
    if (AUTH_ENABLED) {
      const headerToken = parseTokenFromHeaders(req.headers as unknown as Record<string, unknown>);
      const urlToken = parseTokenFromUrl(req.url);
      if (!isTokenValid(headerToken, urlToken)) {
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } catch {
    // Ignore invalid upgrades.
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  }
});

function openBrowser(url: string): void {
  const plat = process.platform;
  if (plat === "darwin") {
    execFile("open", [url], () => {});
  } else if (plat === "win32") {
    execFile("cmd", ["/c", "start", url], () => {});
  } else {
    execFile("xdg-open", [url], () => {});
  }
}

// Boot
await loadTriggersAndBroadcast("startup");
triggerLoader.watch(() => void loadTriggersAndBroadcast("watch"));
await restoreAtStartup();

await fastify.listen({ host: HOST, port: PORT });

const appUrl = `http://${HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST}:${PORT}`;
const appUrlWithToken = AUTH_ENABLED ? `${appUrl}/?token=${encodeURIComponent(AUTH_TOKEN)}` : appUrl;
console.log(`[agmux] Ready at ${appUrl}`);
console.log(`[agmux] Log level: ${LOG_LEVEL}`);
if (AUTH_ENABLED) {
  console.log(`[agmux] Auth token enabled via AGMUX_TOKEN_ENABLED=1 (${AUTH_TOKEN_SOURCE}).`);
  console.log(`[agmux] Token: ${AUTH_TOKEN}`);
  console.log(`[agmux] URL with token: ${appUrlWithToken}`);
  if (AUTH_TOKEN_SOURCE === "generated") {
    console.log("[agmux] Token was generated because AGMUX_TOKEN was unset.");
  }
} else {
  console.log("[agmux] Auth token disabled (opt-in). Set AGMUX_TOKEN_ENABLED=1 to enable API/WS auth.");
}

if (process.env.AGMUX_NO_OPEN !== "1") {
  openBrowser(appUrlWithToken);
}
