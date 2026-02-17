import Fastify from "fastify";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import { PtyManager } from "./pty/manager.js";
import { SqliteStore } from "./persist/sqlite.js";
import { ReadinessEngine, type PtyReadyEvent } from "./readiness/engine.js";
import { ClaudeLogWatcher } from "./readiness/log-watcher.js";
import type {
  ClientToServerMessage,
  PtySummary,
  ServerToClientMessage,
} from "./types.js";
import { WsHub } from "./ws/hub.js";
import { TriggerEngine } from "./triggers/engine.js";
import { TriggerLoader } from "./triggers/loader.js";
import {
  tmuxApplySessionUiOptions,
  tmuxAttachArgs,
  tmuxCapturePaneVisible,
  tmuxCheckSessionConfig,
  tmuxCreateWindow,
  tmuxEnsureSession,
  tmuxKillWindow,
  tmuxListSessions,
  tmuxListWindows,
  tmuxLocateSession,
  tmuxScrollHistory,
  tmuxTargetSession,
  type TmuxServer,
} from "./tmux.js";

const HOST = process.env.HOST ?? "127.0.0.1";
const DEFAULT_PORT = 4821;
const requestedPort = Number(process.env.PORT ?? String(DEFAULT_PORT));
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : DEFAULT_PORT;
const PUBLIC_DIR = path.resolve("public");
const DB_PATH = process.env.DB_PATH ?? path.resolve("data/agent-tide.db");
const TRIGGERS_PATH = process.env.TRIGGERS_PATH ?? path.resolve("triggers/index.js");
const AUTH_TOKEN = process.env.AGENT_TIDE_TOKEN ?? randomBytes(32).toString("hex");
const ALLOW_NON_LOOPBACK_BIND = process.env.AGENT_TIDE_ALLOW_NON_LOOPBACK === "1";
const READINESS_TRACE_MAX = Math.max(100, Number(process.env.AGENT_TIDE_READINESS_TRACE_MAX ?? "2000") || 2000);
const READINESS_TRACE_LOG = process.env.AGENT_TIDE_READINESS_TRACE_LOG === "1";
const WS_ALLOWED_ORIGINS = new Set(
  [
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
    `http://[::1]:${PORT}`,
    ...(process.env.AGENT_TIDE_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0),
  ].map((v) => v.toLowerCase()),
);

const fastify = Fastify({ logger: true, disableRequestLogging: true });

const store = new SqliteStore(DB_PATH);
const ptys = new PtyManager();
const hub = new WsHub();
const triggerEngine = new TriggerEngine();
const triggerLoader = new TriggerLoader(TRIGGERS_PATH);

if (!ALLOW_NON_LOOPBACK_BIND && !isLoopbackHost(HOST)) {
  throw new Error(
    `Refusing to bind to non-loopback host "${HOST}". Set AGENT_TIDE_ALLOW_NON_LOOPBACK=1 to allow.`,
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
  const direct = headers["x-agent-tide-token"];
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
  const token = headerToken ?? urlToken;
  return token != null && token === AUTH_TOKEN;
}

function requestNeedsToken(method: string, rawUrl: string | undefined): boolean {
  const upper = method.toUpperCase();
  if (upper === "GET" || upper === "HEAD" || upper === "OPTIONS") return false;
  return (rawUrl ?? "").startsWith("/api/");
}

function isWsOriginAllowed(origin: string | undefined): boolean {
  if (!origin || origin.length === 0) return true;
  return WS_ALLOWED_ORIGINS.has(origin.toLowerCase());
}

// ---------------------------------------------------------------------------
// Tmux reconciliation: tmux windows are the source of truth.
// Ensures exactly one running PTY attachment per agent_tide window.
// ---------------------------------------------------------------------------
const AGENT_TIDE_SESSION = "agent_tide";
let reconciling = false;

async function reconcileTmuxAttachments(): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  try {
    const windows = await tmuxListWindows(AGENT_TIDE_SESSION);
    const windowTargets = new Set(windows.map((w) => w.target));

    // Map target → ptyId for running agent_tide PTYs.
    const runningByTarget = new Map<string, string>();
    for (const p of ptys.list()) {
      if (
        p.backend === "tmux" &&
        p.status === "running" &&
        p.tmuxSession &&
        tmuxTargetSession(p.tmuxSession) === AGENT_TIDE_SESSION
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
    const shell = process.env.AGENT_TIDE_SHELL ?? process.env.SHELL ?? "bash";
    for (const w of windows) {
      if (!runningByTarget.has(w.target)) {
        const summary = ptys.spawn({
          name: `shell:${path.basename(shell)}`,
          backend: "tmux",
          tmuxSession: w.target,
          command: "tmux",
          args: tmuxAttachArgs(w.target),
          cols: 120,
          rows: 30,
        });
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
  emitReadiness: ({ ptyId, state, indicator, reason, ts, cwd, source }) => {
    recordReadinessTrace({ ptyId, state, indicator, reason, source, ts, cwd });
    broadcast({ type: "pty_ready", ptyId, state, indicator, reason, ts, cwd });
  },
});

const logWatcher = new ClaudeLogWatcher({
  onStateChange: (ptyId, state, reason) => {
    readinessEngine.markLogState(ptyId, state, reason);
  },
});

async function listPtys(): Promise<PtySummary[]> {
  return readinessEngine.withActiveProcesses(ptys.list());
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
  const summary = ptys.getSummary(ptyId);
  const out = summary?.backend === "tmux" ? stripAlternateScreenSequences(data) : data;
  readinessEngine.markOutput(ptyId, out);

  const family = readinessEngine.getAgentFamily(ptyId);
  if (family === "claude" && summary?.cwd) {
    void logWatcher.startWatching(ptyId, summary.cwd);
  }

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
  logWatcher.stopWatching(ptyId);
  readinessEngine.clearLogState(ptyId);
  readinessEngine.markExited(ptyId);
  fastify.log.info({ ptyId, code, signal }, "pty exited");
  broadcast({ type: "pty_exit", ptyId, code, signal });

  // If this was a tmux attachment, reconcile after a brief delay to reattach
  // if the window still exists (or clean up if it doesn't).
  if (summary?.backend === "tmux" && summary.tmuxSession) {
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

fastify.get("/api/session", async (_req, reply) => {
  reply.header("Cache-Control", "no-store");
  return { token: AUTH_TOKEN };
});

fastify.get("/api/ptys", async () => {
  return { ptys: await listPtys() };
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
  const sessions = await tmuxListSessions();
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
  if (serverRaw !== "agent_tide" && serverRaw !== "default") {
    reply.code(400);
    return { error: "server must be agent_tide or default" };
  }
  const located = await tmuxLocateSession(name);
  if (located !== serverRaw) {
    reply.code(404);
    return { error: "tmux session not found on requested server" };
  }
  const checks = await tmuxCheckSessionConfig(name, serverRaw);
  return { checks };
});

fastify.post("/api/ptys", async (req, reply) => {
  const body = isRecord(req.body) ? req.body : {};
  const command = typeof body.command === "string" ? body.command.trim() : "";
  if (command.length === 0) {
    reply.code(400);
    return { error: "command is required" };
  }
  if (body.args != null && !Array.isArray(body.args)) {
    reply.code(400);
    return { error: "args must be an array" };
  }
  if (body.cwd != null && typeof body.cwd !== "string") {
    reply.code(400);
    return { error: "cwd must be a string" };
  }

  let env: Record<string, string> | undefined;
  if (body.env != null) {
    if (!isRecord(body.env)) {
      reply.code(400);
      return { error: "env must be an object" };
    }
    const nextEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.env)) {
      if (typeof v !== "string") {
        reply.code(400);
        return { error: `env.${k} must be a string` };
      }
      nextEnv[k] = v;
    }
    env = nextEnv;
  }

  const args = (body.args ?? []).map(String);
  const cols = Number.isInteger(body.cols) && Number(body.cols) > 0 ? Number(body.cols) : undefined;
  const rows = Number.isInteger(body.rows) && Number(body.rows) > 0 ? Number(body.rows) : undefined;

  const summary = ptys.spawn({
    name: typeof body.name === "string" ? body.name : undefined,
    command,
    args,
    cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    env,
    cols,
    rows,
  });
  store.upsertSession(summary);
  fastify.log.info({ ptyId: summary.id, command, args }, "pty spawned");
  await broadcastPtyList();
  return { id: summary.id };
});

// Create an interactive login shell with zero UI configuration.
fastify.get("/api/worktrees", async () => {
  const wtDir = path.resolve(process.cwd(), ".worktrees");
  let entries: string[];
  try {
    entries = await fs.readdir(wtDir);
  } catch {
    return { worktrees: [] };
  }
  const worktrees: { name: string; path: string }[] = [];
  for (const name of entries) {
    const full = path.join(wtDir, name);
    try {
      const st = await fs.stat(full);
      if (st.isDirectory()) worktrees.push({ name, path: full });
    } catch {
      // skip
    }
  }
  return { worktrees };
});

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

  let cwd: string;
  if (worktree === "__new__") {
    const branch = typeof body.branch === "string" && body.branch.trim()
      ? body.branch.trim()
      : `wt-${Date.now()}`;
    const wtPath = path.resolve(process.cwd(), ".worktrees", branch);
    await new Promise<void>((resolve, reject) => {
      execFile("git", ["worktree", "add", wtPath, "-b", branch], { cwd: process.cwd() }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    cwd = wtPath;
  } else {
    cwd = worktree;
  }

  // Create shell using tmux (reuse /api/ptys/shell logic)
  const shell = process.env.AGENT_TIDE_SHELL ?? process.env.SHELL ?? "bash";
  const SESSION_NAME = "agent_tide";
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

  const name = `shell:${path.basename(shell)}`;
  const summary = ptys.spawn({
    name,
    backend: "tmux",
    tmuxSession: tmuxTarget,
    command: "tmux",
    args: tmuxAttachArgs(tmuxTarget),
    cols: 120,
    rows: 30,
  });
  store.upsertSession(summary);
  fastify.log.info({ ptyId: summary.id, agent, cwd, tmuxSession: tmuxTarget }, "launch: shell spawned");
  await broadcastPtyList();

  // Write the agent launch command into the PTY after a short delay
  setTimeout(() => {
    ptys.write(summary.id, `${agent}\n`);
  }, 300);

  return { id: summary.id };
});

fastify.post("/api/ptys/shell", async (_req, reply) => {
  const shell = process.env.AGENT_TIDE_SHELL ?? process.env.SHELL ?? "bash";
  const backend = process.env.AGENT_TIDE_SHELL_BACKEND ?? "tmux";

  if (backend === "pty") {
    const summary = ptys.spawn({
      name: `shell:${path.basename(shell)}`,
      command: shell,
      cols: 120,
      rows: 30,
    });
    store.upsertSession(summary);
    fastify.log.info({ ptyId: summary.id, shell, backend }, "shell spawned");
    broadcast({ type: "pty_list", ptys: ptys.list() });
    return { id: summary.id };
  }

  // Use a single tmux session with one window per shell.
  try {
    await tmuxEnsureSession(AGENT_TIDE_SESSION, shell);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("shell must")) {
      reply.code(400);
      return { error: message };
    }
    throw err;
  }

  // Reuse an unattached window (e.g. from session creation) or create a new one.
  const windows = await tmuxListWindows(AGENT_TIDE_SESSION);
  const attachedTargets = new Set(
    ptys.list()
      .filter((p) => p.backend === "tmux" && p.tmuxSession)
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
    tmuxTarget = await tmuxCreateWindow(AGENT_TIDE_SESSION, shell);
  }
  const name = `shell:${path.basename(shell)}`;
  const summary = ptys.spawn({
    name,
    backend: "tmux",
    tmuxSession: tmuxTarget,
    command: "tmux",
    args: tmuxAttachArgs(tmuxTarget),
    cols: 120,
    rows: 30,
  });
  store.upsertSession(summary);
  fastify.log.info({ ptyId: summary.id, shell, backend, tmuxSession: tmuxTarget }, "shell spawned");
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
  if (requestedServer != null && requestedServer !== "agent_tide" && requestedServer !== "default") {
    reply.code(400);
    return { error: "server must be agent_tide or default" };
  }

  const located = await tmuxLocateSession(name);
  if (!located) {
    reply.code(404);
    return { error: "tmux session not found" };
  }
  if (requestedServer != null && requestedServer !== located) {
    reply.code(409);
    return { error: `tmux session exists on ${located}, not ${requestedServer}` };
  }
  const server: TmuxServer = located;
  try {
    await tmuxApplySessionUiOptions(name, server);
  } catch {
    // Ignore best-effort option sync; attach can continue.
  }

  const summary = ptys.spawn({
    name: `tmux:${name}`,
    backend: "tmux",
    tmuxSession: name,
    command: "tmux",
    args: tmuxAttachArgs(name, server),
    cols: 120,
    rows: 30,
  });
  store.upsertSession(summary);
  broadcast({ type: "pty_list", ptys: ptys.list() });
  return { id: summary.id };
});

fastify.post("/api/ptys/:id/kill", async (req, reply) => {
  const id = (req.params as any).id as string;
  const live = ptys.getSummary(id);
  const persisted = store.listSessions(500).find((s) => s.id === id) ?? null;
  const summary = live ?? persisted;
  if (!summary) {
    reply.code(404);
    return { error: "unknown PTY" };
  }

  if (summary.backend === "tmux" && summary.tmuxSession) {
    try {
      await tmuxKillWindow(summary.tmuxSession);
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
  // Reconcile agent_tide tmux windows — this is the sole restore mechanism.
  // Any existing tmux window gets an attachment PTY; stale PTYs are cleaned up.
  try {
    await tmuxApplySessionUiOptions(AGENT_TIDE_SESSION);
  } catch {
    // Session may not exist yet; that's fine.
  }
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
      if (summary?.backend === "tmux" && summary.tmuxSession) {
        void tmuxCapturePaneVisible(summary.tmuxSession)
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
      if (!summary || summary.backend !== "tmux" || !summary.tmuxSession) return;
      void tmuxScrollHistory(summary.tmuxSession, msg.direction, msg.lines).catch(() => {
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
    const headerToken = parseTokenFromHeaders(req.headers as unknown as Record<string, unknown>);
    const urlToken = parseTokenFromUrl(req.url);
    if (!isTokenValid(headerToken, urlToken)) {
      socket.destroy();
      return;
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
fastify.log.info(`agent-tide ready at ${appUrl}`);

if (process.env.AGENT_TIDE_NO_OPEN !== "1") {
  openBrowser(appUrl);
}
