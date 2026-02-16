import Fastify from "fastify";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import stripAnsi from "strip-ansi";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import { PtyManager } from "./pty/manager.js";
import { SqliteStore } from "./persist/sqlite.js";
import {
  detectAgentOutputSignal,
  outputShowsAgentPromptMarker,
  type AgentFamily,
} from "./readiness/markers.js";
import type {
  ClientToServerMessage,
  PtyReadinessIndicator,
  PtyReadinessState,
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
  tmuxKillSession,
  tmuxListSessions,
  tmuxLocateSession,
  tmuxNewSessionDetached,
  tmuxScrollHistory,
  type TmuxServer,
  tmuxPaneActiveProcess,
  tmuxPaneCurrentPath,
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

const fastify = Fastify({ logger: true });

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

function mergePtys(live: PtySummary[], persisted: PtySummary[]): PtySummary[] {
  const byId = new Map<string, PtySummary>();
  for (const p of persisted) byId.set(p.id, p);
  for (const p of live) byId.set(p.id, p);
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

type PtyReadyState = {
  state: PtyReadinessState;
  indicator: PtyReadinessIndicator;
  reason: string;
  updatedAt: number;
  lastOutputAt: number;
  lastPromptAt: number;
  timer: NodeJS.Timeout | null;
  busyDelayTimer: NodeJS.Timeout | null;
  modeHint: SessionMode | null;
  agentFamilyHint: AgentFamily | null;
};

const readinessByPty = new Map<string, PtyReadyState>();
const inputLineByPty = new Map<string, string>();
const READINESS_QUIET_MS = 220;
const READINESS_PROMPT_WINDOW_MS = 15_000;
const READINESS_BUSY_DELAY_MS = 120;
const SHELL_PROCESS_NAMES = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu"]);
const AGENT_PROCESS_NAMES = new Set(["codex", "claude", "aider", "goose", "opencode", "cursor-agent"]);

type SessionMode = "shell" | "agent" | "other";

function normalizeProcessName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return (trimmed.split("/").filter(Boolean).at(-1) ?? trimmed).toLowerCase();
}

function isShellProcess(name: string): boolean {
  return SHELL_PROCESS_NAMES.has(normalizeProcessName(name));
}

function isAgentProcess(name: string): boolean {
  const normalized = normalizeProcessName(name);
  if (!normalized) return false;
  if (AGENT_PROCESS_NAMES.has(normalized)) return true;
  return normalized.startsWith("codex") || normalized.startsWith("claude");
}

function agentFamilyFromProcessName(name: string | null | undefined): AgentFamily | null {
  if (!name) return null;
  const normalized = normalizeProcessName(name);
  if (!normalized) return null;
  if (normalized.startsWith("codex")) return "codex";
  if (normalized.startsWith("claude")) return "claude";
  if (AGENT_PROCESS_NAMES.has(normalized)) return "other";
  return null;
}

function detectAgentFamily(summary: PtySummary | null, activeProcess: string | null): AgentFamily | null {
  return (
    agentFamilyFromProcessName(activeProcess) ??
    agentFamilyFromProcessName(summary?.activeProcess ?? null) ??
    agentFamilyFromProcessName(summary?.command ?? null)
  );
}

function classifySessionMode(summary: PtySummary | null, activeProcess: string | null): SessionMode {
  if (activeProcess && isAgentProcess(activeProcess)) return "agent";
  if (summary?.command && isAgentProcess(summary.command)) return "agent";
  if (summary?.name?.startsWith("shell:")) return "shell";
  if (summary?.command && isShellProcess(summary.command)) return "shell";
  if (activeProcess && isShellProcess(activeProcess)) return "shell";
  return "other";
}

function ensureReadiness(ptyId: string): PtyReadyState {
  let st = readinessByPty.get(ptyId);
  if (st) return st;
  st = {
    state: "unknown",
    indicator: "busy",
    reason: "startup",
    updatedAt: Date.now(),
    lastOutputAt: 0,
    lastPromptAt: 0,
    timer: null,
    busyDelayTimer: null,
    modeHint: null,
    agentFamilyHint: null,
  };
  readinessByPty.set(ptyId, st);
  return st;
}

function clearReadinessTimer(st: PtyReadyState): void {
  if (!st.timer) return;
  clearTimeout(st.timer);
  st.timer = null;
}

function clearBusyDelayTimer(st: PtyReadyState): void {
  if (!st.busyDelayTimer) return;
  clearTimeout(st.busyDelayTimer);
  st.busyDelayTimer = null;
}

function scheduleBusyDelay(ptyId: string, reason: string): void {
  const st = ensureReadiness(ptyId);
  if (st.busyDelayTimer) return;
  st.busyDelayTimer = setTimeout(() => {
    st.busyDelayTimer = null;
    // Prompt output arrived during the delay window; keep the PTY ready.
    const promptFresh = st.lastPromptAt > 0 && Date.now() - st.lastPromptAt <= READINESS_BUSY_DELAY_MS + 40;
    if (promptFresh) return;
    setPtyReadiness(ptyId, "busy", reason);
  }, READINESS_BUSY_DELAY_MS);
}

function updateInputLineBuffer(ptyId: string, data: string): boolean {
  let line = inputLineByPty.get(ptyId) ?? "";
  let submitted = false;
  for (const ch of data) {
    if (ch === "\r" || ch === "\n") {
      if (line.trim().length > 0) submitted = true;
      line = "";
      continue;
    }
    if (ch === "\u0008" || ch === "\u007f") {
      line = line.slice(0, -1);
      continue;
    }
    if (ch === "\u0015") {
      line = "";
      continue;
    }
    // Ignore escape/control sequences from navigation keys; only keep visible text.
    if (ch <= "\u001f" || ch === "\u007f") continue;
    line += ch;
    if (line.length > 2000) line = line.slice(-1000);
  }
  inputLineByPty.set(ptyId, line);
  return submitted;
}

function setPtyReadiness(
  ptyId: string,
  state: PtyReadinessState,
  reason: string,
  emitEvent = true,
  indicatorOverride?: PtyReadinessIndicator,
): void {
  const st = ensureReadiness(ptyId);
  const indicator =
    state === "ready" ? "ready" : state === "busy" ? "busy" : (indicatorOverride ?? st.indicator);
  if (st.state === state && st.reason === reason && st.indicator === indicator) return;
  st.state = state;
  st.indicator = indicator;
  st.reason = reason;
  st.updatedAt = Date.now();
  if (!emitEvent) return;
  const cwd = ptys.getSummary(ptyId)?.cwd ?? null;
  broadcast({ type: "pty_ready", ptyId, state, indicator, reason, ts: st.updatedAt, cwd });
}

function outputLooksLikePrompt(chunk: string): boolean {
  const cleaned = stripAnsi(chunk).replaceAll("\r", "\n");
  const tail = cleaned.slice(-800);
  if (/proceed \(y\)\?\s*$/i.test(tail)) return true;
  if (/(password|username|login):\s*$/i.test(tail)) return true;

  const recentLines = tail
    .split("\n")
    .map((line) => line.replaceAll("\u00a0", " ").trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-8);

  for (const line of recentLines) {
    if (/^[^\n]{0,180}[$#%]\s?$/.test(line)) return true;
    if (/^[^\n]{0,180}(?:>|>>|>>>|❯|›)\s?$/u.test(line)) return true;
    if (/^[^\n]{0,180}\s(?:>|>>|>>>|❯|›)\s?$/u.test(line)) return true;
    // Some fullscreen CLIs (e.g. codex/claude) keep helper/footer lines after the prompt.
    if (/^\s*(?:❯|›)\s+\S.{0,240}$/u.test(line)) return true;
  }

  return false;
}

function outputHasVisibleText(chunk: string): boolean {
  const visible = stripAnsi(chunk)
    .replaceAll("\u00a0", " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return visible.length > 0;
}

async function tmuxSessionShowsPrompt(
  ptyId: string,
  tmuxSession: string,
  mode: SessionMode,
  agentFamily: AgentFamily | null,
): Promise<boolean> {
  const snapshot = await tmuxCapturePaneVisible(tmuxSession);
  if (!snapshot) return false;
  const promptVisible =
    mode === "agent"
      ? outputShowsAgentPromptMarker(snapshot, agentFamily) || (agentFamily === "other" && outputLooksLikePrompt(snapshot))
      : outputLooksLikePrompt(snapshot);
  if (!promptVisible) return false;
  ensureReadiness(ptyId).lastPromptAt = Date.now();
  return true;
}

function scheduleReadinessRecompute(ptyId: string, delayMs = READINESS_QUIET_MS): void {
  const st = ensureReadiness(ptyId);
  clearReadinessTimer(st);
  st.timer = setTimeout(() => {
    st.timer = null;
    void recomputeReadiness(ptyId);
  }, Math.max(10, delayMs));
}

function markReadyOutput(ptyId: string, chunk: string): void {
  const st = ensureReadiness(ptyId);
  const summary = ptys.getSummary(ptyId);
  const now = Date.now();
  const classifiedMode = classifySessionMode(summary, summary?.activeProcess ?? null);
  const mode = classifiedMode === "other" && summary?.backend === "tmux" && st.modeHint ? st.modeHint : classifiedMode;
  const agentFamily = mode === "agent" ? (detectAgentFamily(summary, summary?.activeProcess ?? null) ?? st.agentFamilyHint) : null;
  if (mode !== "other") st.modeHint = mode;
  if (agentFamily) st.agentFamilyHint = agentFamily;
  const agentSignal = mode === "agent" ? detectAgentOutputSignal(chunk, agentFamily) : "none";
  if (agentSignal === "busy") {
    clearBusyDelayTimer(st);
    st.lastOutputAt = now;
    st.lastPromptAt = 0;
    setPtyReadiness(ptyId, "busy", `agent:busy-marker${agentFamily ? `:${agentFamily}` : ""}`);
    scheduleReadinessRecompute(ptyId);
    return;
  }
  if (agentSignal === "prompt") {
    clearBusyDelayTimer(st);
    st.lastOutputAt = now;
    st.lastPromptAt = now;
    setPtyReadiness(ptyId, "unknown", `agent:prompt-marker${agentFamily ? `:${agentFamily}` : ""}`);
    scheduleReadinessRecompute(ptyId);
    return;
  }
  const promptLike = outputLooksLikePrompt(chunk);
  if (!promptLike && !outputHasVisibleText(chunk)) return;
  st.lastOutputAt = now;
  if (mode === "agent") {
    st.lastPromptAt = 0;
    if (st.state === "ready" || st.state === "unknown") scheduleBusyDelay(ptyId, "agent:output");
    else setPtyReadiness(ptyId, "busy", "agent:output");
    scheduleReadinessRecompute(ptyId);
    return;
  }
  if (promptLike) {
    clearBusyDelayTimer(st);
    st.lastPromptAt = now;
    // Prompt redraws can stream continuously; keep these sessions marked ready.
    setPtyReadiness(ptyId, "ready", "prompt");
    scheduleReadinessRecompute(ptyId);
    return;
  }
  // Delay busy slightly so prompt redraw chunks don't flash busy, while sustained output still flips to busy.
  if (st.state === "ready" || st.state === "unknown") scheduleBusyDelay(ptyId, "output");
  else setPtyReadiness(ptyId, "busy", "output");
  scheduleReadinessRecompute(ptyId);
}

function markReadyInput(ptyId: string, data: string): void {
  const st = ensureReadiness(ptyId);
  clearBusyDelayTimer(st);
  st.lastOutputAt = Date.now();
  const submittedCommand = updateInputLineBuffer(ptyId, data);
  st.lastPromptAt = 0;
  if (submittedCommand) {
    // Command submission with no immediate output (e.g. "sleep 1") should still show busy.
    scheduleBusyDelay(ptyId, "input:command");
    scheduleReadinessRecompute(ptyId);
    return;
  }
  // Keep ready sessions stable while user types; recompute switches to busy when output resumes.
  if (st.state !== "ready") setPtyReadiness(ptyId, "busy", "input");
  scheduleReadinessRecompute(ptyId);
}

function markReadyExited(ptyId: string): void {
  const st = ensureReadiness(ptyId);
  clearReadinessTimer(st);
  clearBusyDelayTimer(st);
  inputLineByPty.delete(ptyId);
  setPtyReadiness(ptyId, "busy", "exited");
}

async function recomputeReadiness(ptyId: string): Promise<void> {
  const st = ensureReadiness(ptyId);
  const summary = ptys.getSummary(ptyId);
  if (!summary || summary.status !== "running") {
    setPtyReadiness(ptyId, "busy", "exited");
    return;
  }

  const now = Date.now();
  let activeProcess: string | null = summary.activeProcess ?? null;
  if (summary.backend === "tmux" && summary.tmuxSession) {
    const [proc, liveCwd] = await Promise.all([
      tmuxPaneActiveProcess(summary.tmuxSession),
      tmuxPaneCurrentPath(summary.tmuxSession),
    ]);
    activeProcess = proc;
    if (liveCwd) ptys.updateCwd(ptyId, liveCwd);
  } else {
    const pid = ptys.getPid(ptyId);
    if (pid) {
      try {
        const liveCwd = await fs.readlink(`/proc/${pid}/cwd`);
        if (liveCwd) ptys.updateCwd(ptyId, liveCwd);
      } catch {
        // Process may have exited; ignore.
      }
    }
  }
  const mode = classifySessionMode(summary, activeProcess);
  const agentFamily = mode === "agent" ? detectAgentFamily(summary, activeProcess) : null;
  st.modeHint = mode;
  st.agentFamilyHint = agentFamily;

  const sinceOutput = now - st.lastOutputAt;
  if (st.lastOutputAt > 0 && sinceOutput < READINESS_QUIET_MS) {
    // Avoid re-marking busy immediately after a prompt marker redraw.
    const promptJustSeen = st.lastPromptAt > 0 && now - st.lastPromptAt <= READINESS_BUSY_DELAY_MS + 80;
    if (promptJustSeen) {
      scheduleReadinessRecompute(ptyId, READINESS_QUIET_MS - sinceOutput + 5);
      return;
    }
    if (mode !== "agent" && summary.backend === "tmux" && summary.tmuxSession && activeProcess && !isShellProcess(activeProcess)) {
      if (await tmuxSessionShowsPrompt(ptyId, summary.tmuxSession, mode, agentFamily)) {
        setPtyReadiness(ptyId, "ready", "prompt-visible");
        scheduleReadinessRecompute(ptyId, READINESS_QUIET_MS - sinceOutput + 5);
        return;
      }
    }
    setPtyReadiness(ptyId, "busy", mode === "agent" ? "agent:output" : "output");
    scheduleReadinessRecompute(ptyId, READINESS_QUIET_MS - sinceOutput + 5);
    return;
  }

  const promptFresh = st.lastPromptAt > 0 && now - st.lastPromptAt <= READINESS_PROMPT_WINDOW_MS;
  if (promptFresh) {
    if (mode === "agent") setPtyReadiness(ptyId, "unknown", "agent:prompt-stable");
    else setPtyReadiness(ptyId, "ready", "prompt");
    return;
  }

  if (summary.backend === "tmux" && summary.tmuxSession && activeProcess && !isShellProcess(activeProcess)) {
    if (await tmuxSessionShowsPrompt(ptyId, summary.tmuxSession, mode, agentFamily)) {
      if (mode === "agent") setPtyReadiness(ptyId, "unknown", "agent:prompt-visible");
      else setPtyReadiness(ptyId, "ready", "prompt-visible");
      return;
    }
    setPtyReadiness(ptyId, "busy", `process:${normalizeProcessName(activeProcess)}`);
    return;
  }

  if (summary.backend === "tmux" && summary.tmuxSession && !activeProcess) {
    if (await tmuxSessionShowsPrompt(ptyId, summary.tmuxSession, mode, agentFamily)) {
      if (mode === "agent") setPtyReadiness(ptyId, "unknown", "agent:prompt-visible");
      else setPtyReadiness(ptyId, "ready", "prompt-visible");
      return;
    }
    setPtyReadiness(ptyId, "unknown", "tmux:process-unresolved");
    return;
  }

  if (summary.backend === "tmux" && (!activeProcess || isShellProcess(activeProcess))) {
    if (mode === "agent") setPtyReadiness(ptyId, "unknown", "agent:idle-shell");
    else setPtyReadiness(ptyId, "ready", "idle-shell");
    return;
  }

  if (mode === "agent") {
    setPtyReadiness(ptyId, "unknown", "agent:idle");
    return;
  }
  setPtyReadiness(ptyId, "unknown", "unknown");
}

async function withActiveProcesses(items: PtySummary[]): Promise<PtySummary[]> {
  return Promise.all(
    items.map(async (p) => {
      const st = ensureReadiness(p.id);
      if (p.status !== "running") {
        clearReadinessTimer(st);
        clearBusyDelayTimer(st);
        setPtyReadiness(p.id, "busy", "exited", false);
        return {
          ...p,
          activeProcess: p.activeProcess ?? null,
          ready: false,
          readyState: "busy",
          readyIndicator: "busy",
          readyReason: "exited",
        };
      }
      const isTmux = p.backend === "tmux" && p.tmuxSession;
      const [activeProcess, liveCwd] = isTmux
        ? await Promise.all([tmuxPaneActiveProcess(p.tmuxSession!), tmuxPaneCurrentPath(p.tmuxSession!)])
        : [null, null];
      const effectiveCwd = liveCwd ?? p.cwd;
      const mode = classifySessionMode(p, activeProcess);
      const agentFamily = mode === "agent" ? detectAgentFamily(p, activeProcess) : null;
      st.modeHint = mode;
      st.agentFamilyHint = agentFamily;
      const now = Date.now();
      const promptFresh = st.lastPromptAt > 0 && now - st.lastPromptAt <= READINESS_PROMPT_WINDOW_MS;
      if (promptFresh) {
        if (mode === "agent") setPtyReadiness(p.id, "unknown", "agent:prompt-stable", false);
        else setPtyReadiness(p.id, "ready", "prompt", false);
      } else if (p.backend === "tmux" && p.tmuxSession && activeProcess && !isShellProcess(activeProcess)) {
        if (await tmuxSessionShowsPrompt(p.id, p.tmuxSession, mode, agentFamily)) {
          if (mode === "agent") setPtyReadiness(p.id, "unknown", "agent:prompt-visible", false);
          else setPtyReadiness(p.id, "ready", "prompt-visible", false);
        } else {
          setPtyReadiness(p.id, "busy", `process:${normalizeProcessName(activeProcess)}`, false);
        }
      } else if (p.backend === "tmux" && p.tmuxSession && !activeProcess) {
        if (await tmuxSessionShowsPrompt(p.id, p.tmuxSession, mode, agentFamily)) {
          if (mode === "agent") setPtyReadiness(p.id, "unknown", "agent:prompt-visible", false);
          else setPtyReadiness(p.id, "ready", "prompt-visible", false);
        } else {
          setPtyReadiness(p.id, "unknown", "tmux:process-unresolved", false);
        }
      } else if (p.backend === "tmux") {
        if (mode === "agent") setPtyReadiness(p.id, "unknown", "agent:idle-shell", false);
        else setPtyReadiness(p.id, "ready", "idle-shell", false);
      } else if (mode === "agent") {
        setPtyReadiness(p.id, "unknown", "agent:idle", false);
      } else {
        setPtyReadiness(p.id, "unknown", "unknown", false);
      }
      return {
        ...p,
        activeProcess,
        cwd: effectiveCwd,
        ready: st.state === "ready",
        readyState: st.state,
        readyIndicator: st.indicator,
        readyReason: st.reason,
      };
    }),
  );
}

async function listPtys(): Promise<PtySummary[]> {
  return withActiveProcesses(mergePtys(ptys.list(), store.listSessions()));
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
  markReadyOutput(ptyId, out);
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
  markReadyExited(ptyId);
  broadcast({ type: "pty_exit", ptyId, code, signal });

  // If this PTY is an attachment to a persistent tmux session, try to reattach.
  // This keeps "agent is alive" semantics separate from an individual server-side PTY attachment.
  if (summary?.backend === "tmux" && summary.tmuxSession) {
    void (async () => {
      const server = await tmuxLocateSession(summary.tmuxSession!);
      if (!server) return;
      try {
        await tmuxApplySessionUiOptions(summary.tmuxSession!, server);
      } catch {
        // ignore best-effort session option sync
      }
      // Small delay to avoid tight loops if tmux is unstable.
      await new Promise((r) => setTimeout(r, 250));
      const re = ptys.spawn({
        id: summary.id,
        createdAt: summary.createdAt,
        name: summary.name,
        backend: "tmux",
        tmuxSession: summary.tmuxSession,
        command: "tmux",
        args: tmuxAttachArgs(summary.tmuxSession!, server),
        cols: 120,
        rows: 30,
      });
      store.upsertSession(re);
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
  await broadcastPtyList();
  return { id: summary.id };
});

// Create an interactive login shell with zero UI configuration.
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
    broadcast({ type: "pty_list", ptys: mergePtys(ptys.list(), store.listSessions()) });
    return { id: summary.id };
  }

  const tmuxSession = `agent_tide_${randomUUID()}`;
  try {
    await tmuxNewSessionDetached(tmuxSession, shell);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("shell must")) {
      reply.code(400);
      return { error: message };
    }
    throw err;
  }
  const name = `shell:${path.basename(shell)}`;
  const summary = ptys.spawn({
    name,
    backend: "tmux",
    tmuxSession,
    command: "tmux",
    args: tmuxAttachArgs(tmuxSession),
    cols: 120,
    rows: 30,
  });
  store.upsertSession(summary);
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
  broadcast({ type: "pty_list", ptys: mergePtys(ptys.list(), store.listSessions()) });
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
      await tmuxKillSession(summary.tmuxSession);
    } catch {
      // If it's already gone, continue with local cleanup.
    }
  }
  ptys.kill(id);

  // If there is no live PTY process (e.g. server restarted but didn't attach yet),
  // ensure metadata reflects the kill immediately.
  const after = ptys.getSummary(id) ?? summary;
  after.status = "exited";
  after.exitCode = after.exitCode ?? null;
  after.exitSignal = after.exitSignal ?? null;
  store.upsertSession(after);
  markReadyExited(id);
  await broadcastPtyList();
  return { ok: true };
});

fastify.post("/api/triggers/reload", async () => {
  await loadTriggersAndBroadcast("manual");
  return { ok: true };
});

async function restorePersistentTmuxSessions(): Promise<void> {
  const persisted = store.listSessions(500);
  for (const s of persisted) {
    if (s.backend !== "tmux" || !s.tmuxSession) continue;
    if (ptys.getSummary(s.id)) continue;

    const server = await tmuxLocateSession(s.tmuxSession);
    if (!server) {
      s.status = "exited";
      store.upsertSession(s);
      continue;
    }
    try {
      await tmuxApplySessionUiOptions(s.tmuxSession, server);
    } catch {
      // ignore best-effort session option sync
    }

    const attached = ptys.spawn({
      id: s.id,
      createdAt: s.createdAt,
      name: s.name,
      backend: "tmux",
      tmuxSession: s.tmuxSession,
      command: "tmux",
      args: tmuxAttachArgs(s.tmuxSession, server),
      cols: 120,
      rows: 30,
    });
    store.upsertSession(attached);
  }
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
    .catch(() => send(ws, { type: "pty_list", ptys: mergePtys(ptys.list(), store.listSessions()) }));

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
      markReadyInput(msg.ptyId, msg.data);
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
await restorePersistentTmuxSessions();

await fastify.listen({ host: HOST, port: PORT });

const appUrl = `http://${HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST}:${PORT}`;
fastify.log.info(`agent-tide ready at ${appUrl}`);

if (process.env.AGENT_TIDE_NO_OPEN !== "1") {
  openBrowser(appUrl);
}
