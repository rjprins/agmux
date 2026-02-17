import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { THEMES, DEFAULT_THEME_KEY, applyTheme, type Theme } from "./themes";

type PtyReadinessState = "ready" | "busy" | "unknown";
type PtyReadinessIndicator = "ready" | "busy";

type PtySummary = {
  id: string;
  name: string;
  backend?: "pty" | "tmux";
  tmuxSession?: string | null;
  activeProcess?: string | null;
  ready?: boolean;
  readyState?: PtyReadinessState;
  readyIndicator?: PtyReadinessIndicator;
  readyReason?: string | null;
  readyStateChangedAt?: number | null;
  command: string;
  args: string[];
  cwd: string | null;
  createdAt: number;
  status: "running" | "exited";
  exitCode?: number | null;
  exitSignal?: string | null;
};

type TmuxSessionInfo = {
  name: string;
  server: "agent_tide" | "default";
  createdAt: number | null;
  windows: number | null;
};

type TmuxSessionCheck = {
  name: string;
  server: "agent_tide" | "default";
  warnings: string[];
  observed: {
    mouse: string | null;
    alternateScreen: string | null;
    historyLimit: number | null;
    terminalOverrides: string | null;
  };
};

type ServerMsg =
  | { type: "pty_list"; ptys: PtySummary[] }
  | { type: "pty_output"; ptyId: string; data: string }
  | { type: "pty_exit"; ptyId: string; code: number | null; signal: string | null }
  | {
      type: "pty_ready";
      ptyId: string;
      state: PtyReadinessState;
      indicator: PtyReadinessIndicator;
      reason: string;
      ts: number;
      cwd?: string | null;
    }
  | { type: "trigger_fired"; ptyId: string; trigger: string; match: string; line: string; ts: number }
  | { type: "pty_highlight"; ptyId: string; reason: string; ttlMs: number }
  | { type: "trigger_error"; ptyId: string; trigger: string; ts: number; message: string };

const $ = (id: string) => document.getElementById(id)!;

const listEl = $("pty-list");
const terminalEl = $("terminal");
const eventsEl = document.getElementById("events");
const inputContextEl = $("input-context");
const inputContextToggleEl = $("input-context-toggle");
const inputContextLastEl = $("input-context-last");
const inputHistoryLabelEl = $("input-history-label");
const inputHistoryListEl = $("input-history-list");

let ptys: PtySummary[] = [];
let activePtyId: string | null = null;
let inputHistoryExpanded = false;

const ACTIVE_PTY_KEY = "agent-tide:activePty";

function saveActivePty(ptyId: string | null): void {
  try {
    if (!ptyId) {
      sessionStorage.removeItem(ACTIVE_PTY_KEY);
      // Cleanup legacy shared storage value from older builds.
      localStorage.removeItem(ACTIVE_PTY_KEY);
      return;
    }
    const p = ptys.find((x) => x.id === ptyId);
    sessionStorage.setItem(
      ACTIVE_PTY_KEY,
      JSON.stringify({
        ptyId,
        tmuxSession: p?.tmuxSession ?? null,
      }),
    );
    // Cleanup legacy shared storage value from older builds.
    localStorage.removeItem(ACTIVE_PTY_KEY);
  } catch {
    // ignore storage failures
  }
}

function loadSavedActivePty(): { ptyId: string; tmuxSession: string | null } | null {
  try {
    // sessionStorage is tab-scoped: each browser tab remembers its own active PTY.
    // Fall back to legacy localStorage once, then migrate and clear it.
    const raw = sessionStorage.getItem(ACTIVE_PTY_KEY) ?? localStorage.getItem(ACTIVE_PTY_KEY);
    if (!raw) return null;
    if (!sessionStorage.getItem(ACTIVE_PTY_KEY)) {
      sessionStorage.setItem(ACTIVE_PTY_KEY, raw);
    }
    localStorage.removeItem(ACTIVE_PTY_KEY);
    const v = JSON.parse(raw);
    return typeof v.ptyId === "string" ? { ptyId: v.ptyId, tmuxSession: v.tmuxSession ?? null } : null;
  } catch { return null; }
}

type HistoryEntry = {
  text: string;
  bufferLine: number;
};

const ptyTitles = new Map<string, string>();
const ptyLastInput = new Map<string, string>();
const ptyInputHistory = new Map<string, HistoryEntry[]>();
const ptyInputLineBuffers = new Map<string, string>();
const ptyInputProcessHints = new Map<string, string>();
type PtyReadyInfo = { state: PtyReadinessState; indicator: PtyReadinessIndicator; reason: string };
const ptyReady = new Map<string, PtyReadyInfo>();
const ptyStateChangedAt = new Map<string, number>();
const MAX_INPUT_HISTORY = 40;

function formatElapsedTime(sinceMs: number): string {
  const delta = Date.now() - sinceMs;
  if (delta < 0) return "";
  const secs = Math.floor(delta / 1000);
  if (secs < 5) return "now";
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function readinessFromSummary(p: PtySummary): PtyReadyInfo {
  const state = p.readyState ?? (typeof p.ready === "boolean" ? (p.ready ? "ready" : "busy") : "unknown");
  const indicator = p.readyIndicator ?? (state === "ready" ? "ready" : "busy");
  if (p.readyStateChangedAt) ptyStateChangedAt.set(p.id, p.readyStateChangedAt);
  return { state, indicator, reason: String(p.readyReason ?? "") };
}

const pendingHistorySaves = new Set<string>();
let historySaveTimer: ReturnType<typeof setTimeout> | null = null;
const HISTORY_SAVE_DEBOUNCE_MS = 500;

function savePtyInputMeta(changedPtyId?: string): void {
  if (changedPtyId) pendingHistorySaves.add(changedPtyId);
  if (historySaveTimer) return;
  historySaveTimer = setTimeout(() => {
    historySaveTimer = null;
    const ids = [...pendingHistorySaves];
    pendingHistorySaves.clear();
    for (const ptyId of ids) {
      const lastInput = ptyLastInput.get(ptyId);
      const processHint = ptyInputProcessHints.get(ptyId);
      const history = ptyInputHistory.get(ptyId) ?? [];
      void authFetch(`/api/ptys/${encodeURIComponent(ptyId)}/input-history`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lastInput, processHint, history }),
      }).catch(() => {
        // ignore save failures
      });
    }
  }, HISTORY_SAVE_DEBOUNCE_MS);
}

async function loadPtyInputMeta(): Promise<void> {
  const res = await authFetch("/api/input-history");
  if (!res.ok) return;
  const json = (await res.json()) as { history?: Record<string, unknown> };
  const data = json.history;
  if (!data || typeof data !== "object") return;
  for (const [ptyId, meta] of Object.entries(data)) {
    if (!ptyId || !meta || typeof meta !== "object") continue;
    const rec = meta as { lastInput?: unknown; processHint?: unknown; history?: unknown };
    if (typeof rec.lastInput === "string" && rec.lastInput.trim()) ptyLastInput.set(ptyId, rec.lastInput);
    if (typeof rec.processHint === "string" && rec.processHint.trim()) ptyInputProcessHints.set(ptyId, rec.processHint);
    if (Array.isArray(rec.history)) {
      const entries: HistoryEntry[] = rec.history
        .filter((x: any) => x && typeof x.text === "string" && x.text.trim().length > 0)
        .map((x: any) => ({ text: x.text, bufferLine: typeof x.bufferLine === "number" ? x.bufferLine : 0 }));
      if (entries.length > 0) ptyInputHistory.set(ptyId, entries.slice(-MAX_INPUT_HISTORY));
    }
  }
}

function prunePtyInputMeta(ptyIds: Set<string>): void {
  for (const ptyId of [...ptyLastInput.keys()]) {
    if (ptyIds.has(ptyId)) continue;
    ptyLastInput.delete(ptyId);
  }
  for (const ptyId of [...ptyInputProcessHints.keys()]) {
    if (ptyIds.has(ptyId)) continue;
    ptyInputProcessHints.delete(ptyId);
  }
  for (const ptyId of [...ptyInputHistory.keys()]) {
    if (ptyIds.has(ptyId)) continue;
    ptyInputHistory.delete(ptyId);
  }
}

// Input history is loaded from the server after auth; see boot sequence below.

const btnNew = $("btn-new") as HTMLButtonElement;
const tmuxSessionSelect = $("tmux-session-select") as HTMLSelectElement;
const btnSidebarToggle = $("btn-sidebar-toggle") as HTMLButtonElement;
btnNew.disabled = true;

let sidebarCollapsed = false;
function toggleSidebar(): void {
  sidebarCollapsed = !sidebarCollapsed;
  const app = document.getElementById("app")!;
  const sidebar = document.querySelector(".sidebar")!;
  app.classList.toggle("sidebar-collapsed", sidebarCollapsed);
  sidebar.classList.toggle("collapsed", sidebarCollapsed);
  btnSidebarToggle.innerHTML = sidebarCollapsed ? "&raquo;" : "&laquo;";
  btnSidebarToggle.title = sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar";
  renderList();
  // Re-fit terminal after sidebar resize transition
  setTimeout(() => {
    const st = activePtyId ? terms.get(activePtyId) : null;
    if (st) st.fit.fit();
  }, 250);
}
btnSidebarToggle.addEventListener("click", toggleSidebar);

// --- Theme ---

const THEME_KEY = "agent-tide:theme";
let activeThemeKey = localStorage.getItem(THEME_KEY) ?? DEFAULT_THEME_KEY;
let activeTheme: Theme = THEMES.get(activeThemeKey) ?? THEMES.get(DEFAULT_THEME_KEY)!;

const themeSelect = $("theme-select") as HTMLSelectElement;
for (const [key, theme] of THEMES) {
  const opt = document.createElement("option");
  opt.value = key;
  opt.textContent = theme.name;
  themeSelect.appendChild(opt);
}
themeSelect.value = activeThemeKey;

// Apply theme to CSS vars immediately (before any terminal creation).
applyTheme(activeTheme, []);

themeSelect.addEventListener("change", () => {
  const next = THEMES.get(themeSelect.value);
  if (!next) return;
  activeThemeKey = themeSelect.value;
  activeTheme = next;
  localStorage.setItem(THEME_KEY, activeThemeKey);
  applyTheme(activeTheme, terms.values());
  renderList();
});

type TermState = {
  ptyId: string;
  backend: "pty" | "tmux" | undefined;
  container: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  lastResize: { cols: number; rows: number } | null;
};

const terms = new Map<string, TermState>();
const subscribed = new Set<string>();
let authToken = "";
let ws: WebSocket | null = null;
const TERMINAL_SCROLLBACK_LINES = 50_000;
const TMUX_TERMINAL_SCROLLBACK_LINES = 0;
let tmuxSessions: TmuxSessionInfo[] = [];

const placeholderEl = document.createElement("div");
placeholderEl.className = "terminal-placeholder";
placeholderEl.textContent = "select a PTY";
terminalEl.appendChild(placeholderEl);

function startAssetReloadPoller(): void {
  const urls = ["/app.js", "/styles.css", "/index.html", "/xterm.css"];
  const last = new Map<string, string>();

  async function headEtag(url: string): Promise<string> {
    try {
      const res = await fetch(url, { method: "HEAD", cache: "no-store" });
      if (!res.ok) return "";
      return res.headers.get("etag") ?? "";
    } catch {
      return "";
    }
  }

  async function tick(): Promise<void> {
    for (const url of urls) {
      const etag = await headEtag(url);
      if (!etag) continue;
      const prev = last.get(url);
      if (prev && prev !== etag) {
        location.reload();
        return;
      }
      last.set(url, etag);
    }
  }

  // Cheap fallback when the supervisor isn't running (or ports don't match).
  setInterval(() => void tick(), 1500);
  void tick();
}

function createTermState(ptyId: string, backend?: "pty" | "tmux"): TermState {
  const container = document.createElement("div");
  container.className = "term-pane hidden";
  container.dataset.ptyId = ptyId;
  terminalEl.appendChild(container);

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    theme: activeTheme.terminal,
    scrollback: backend === "tmux" ? TMUX_TERMINAL_SCROLLBACK_LINES : TERMINAL_SCROLLBACK_LINES,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(container);

  // For tmux PTYs, intercept wheel events and scroll tmux history instead.
  container.addEventListener(
    "wheel",
    (ev) => {
      if (ev.ctrlKey) return;
      const st = terms.get(ptyId);
      if (st?.backend !== "tmux") return;
      const dy = ev.deltaY;
      if (!Number.isFinite(dy) || dy === 0) return;
      ev.preventDefault();
      const lines = Math.max(1, Math.round(Math.abs(dy) / 40));
      sendWsMessage({
        type: "tmux_control",
        ptyId,
        direction: dy > 0 ? "down" : "up",
        lines,
      });
    },
    { passive: false, capture: true },
  );

  term.onData((data) => {
    if (activePtyId !== ptyId) return;
    trackUserInput(ptyId, data);
    sendWsMessage({ type: "input", ptyId, data });
  });

  const copyToast = document.createElement("div");
  copyToast.className = "copy-toast";
  copyToast.textContent = "Copied";
  container.appendChild(copyToast);
  let copyToastTimer = 0;

  term.onSelectionChange(() => {
    const sel = term.getSelection();
    if (!sel) return;
    navigator.clipboard.writeText(sel).then(() => {
      clearTimeout(copyToastTimer);
      copyToast.classList.add("visible");
      copyToastTimer = window.setTimeout(() => copyToast.classList.remove("visible"), 800);
    }).catch(() => {});
  });

  term.onTitleChange((title) => {
    const t = title.trim();
    if (!t) return;
    if (ptyTitles.get(ptyId) === t) return;
    ptyTitles.set(ptyId, t);
    renderList();
  });

  return { ptyId, backend, container, term, fit, lastResize: null };
}

function ensureTerm(ptyId: string, backend?: "pty" | "tmux"): TermState {
  const existing = terms.get(ptyId);
  if (existing) {
    if (backend && existing.backend !== backend) {
      existing.backend = backend;
      const target = backend === "tmux" ? TMUX_TERMINAL_SCROLLBACK_LINES : TERMINAL_SCROLLBACK_LINES;
      if (existing.term.options.scrollback !== target) {
        existing.term.options.scrollback = target;
        if (backend === "tmux") existing.term.clear();
      }
    }
    return existing;
  }
  const created = createTermState(ptyId, backend);
  terms.set(ptyId, created);
  return created;
}

function removeTerm(ptyId: string): void {
  const st = terms.get(ptyId);
  if (!st) return;
  try {
    st.term.dispose();
  } catch {
    // ignore
  }
  st.container.remove();
  terms.delete(ptyId);
  ptyTitles.delete(ptyId);
  ptyInputLineBuffers.delete(ptyId);
  ptyReady.delete(ptyId);
  ptyStateChangedAt.delete(ptyId);
}

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const tokenPart = authToken ? `?token=${encodeURIComponent(authToken)}` : "";
  return `${proto}://${location.host}/ws${tokenPart}`;
}

function sendWsMessage(msg: unknown): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function authHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  if (authToken) headers.set("x-agent-tide-token", authToken);
  return headers;
}

async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: authHeaders(init?.headers),
  });
}

function connectWs(): void {
  ws = new WebSocket(wsUrl());

  ws.addEventListener("open", () => {
    addEvent(`WS connected`);
    for (const ptyId of subscribed) {
      sendWsMessage({ type: "subscribe", ptyId });
    }
  });

  ws.addEventListener("close", () => {
    addEvent(`WS disconnected`);
  });

  ws.addEventListener("message", (ev) => {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(String(ev.data)) as ServerMsg;
    } catch {
      return;
    }
    onServerMsg(msg);
  });
}

async function fetchSessionToken(): Promise<void> {
  const res = await fetch("/api/session", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`session request failed (${res.status})`);
  }
  const json = (await res.json()) as { token?: unknown };
  if (typeof json.token !== "string" || json.token.length === 0) {
    throw new Error("invalid session token response");
  }
  authToken = json.token;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readApiError(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as { error?: unknown };
    if (typeof json.error === "string" && json.error.length > 0) {
      return json.error;
    }
  } catch {
    // ignore
  }
  return `HTTP ${res.status}`;
}

// Supervisor control plane: tells us when to reload after agent edits.
(() => {
  const qs = new URLSearchParams(location.search);
  if (qs.has("nosup")) {
    startAssetReloadPoller();
    return;
  }

  const supUrl = `${location.protocol}//127.0.0.1:4822/events`;
  const es = new EventSource(supUrl);
  let supOk = false;
  const pollFallback = window.setTimeout(() => {
    if (!supOk) startAssetReloadPoller();
  }, 1200);

  es.onopen = () => {
    supOk = true;
    window.clearTimeout(pollFallback);
  };
  es.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data) as any;
      if (m?.type === "commit") addEvent(`commit ${String(m.sha ?? "").slice(0, 12)} ${m.msg ?? ""}`);
      if (m?.type === "status") addEvent(`server ${m.server}`);
      if (m?.type === "reload") {
        // Ignore informational reload events that don't require refresh.
        if (m.reason === "triggers_updated") return;
        addEvent(`reload (${m.reason ?? "unknown"})`);
        location.reload();
      }
    } catch {
      // ignore
    }
  };
  es.onerror = () => {
    addEvent("supervisor events disconnected");
  };
})();

function onServerMsg(msg: ServerMsg): void {
  if (msg.type === "pty_list") {
    ptys = msg.ptys;
    if (activePtyId) {
      const active = ptys.find((p) => p.id === activePtyId);
      if (!active || active.status !== "running") {
        activePtyId = null;
        saveActivePty(null);
      }
    }

    // Drop terminals for sessions that are no longer running.
    const running = new Set(ptys.filter((p) => p.status === "running").map((p) => p.id));
    const allKnown = new Set(ptys.map((p) => p.id));
    prunePtyInputMeta(allKnown);
    for (const p of ptys) {
      ptyReady.set(p.id, readinessFromSummary(p));
    }
    for (const ptyId of ptyReady.keys()) {
      if (!running.has(ptyId)) ptyReady.delete(ptyId);
    }
    for (const ptyId of ptyStateChangedAt.keys()) {
      if (!running.has(ptyId)) ptyStateChangedAt.delete(ptyId);
    }
    for (const ptyId of terms.keys()) {
      if (!running.has(ptyId)) removeTerm(ptyId);
    }
    for (const [ptyId, st] of terms) {
      const p = ptys.find((x) => x.id === ptyId);
      if (p?.backend) st.backend = p.backend;
      const targetScrollback = p?.backend === "tmux" ? TMUX_TERMINAL_SCROLLBACK_LINES : TERMINAL_SCROLLBACK_LINES;
      if (st.term.options.scrollback !== targetScrollback) {
        st.term.options.scrollback = targetScrollback;
        if (targetScrollback === 0) st.term.clear();
      }
    }

    updateTerminalVisibility();
    reflowActiveTerm();
    renderList();
    return;
  }
  if (msg.type === "pty_output") {
    const backend = ptys.find((p) => p.id === msg.ptyId)?.backend;
    const st = ensureTerm(msg.ptyId, backend);
    st.term.write(msg.data);
    return;
  }
  if (msg.type === "pty_exit") {
    ptyReady.set(msg.ptyId, { state: "busy", indicator: "busy", reason: "exited" });
    addEvent(`PTY exited: ${msg.ptyId} code=${msg.code ?? "?"} signal=${msg.signal ?? "-"}`);
    refreshList();
    return;
  }
  if (msg.type === "pty_ready") {
    ptyReady.set(msg.ptyId, { state: msg.state, indicator: msg.indicator, reason: msg.reason });
    ptyStateChangedAt.set(msg.ptyId, msg.ts);
    if (msg.cwd != null) {
      const p = ptys.find((x) => x.id === msg.ptyId);
      if (p) p.cwd = msg.cwd;
    }
    renderList();
    return;
  }
  if (msg.type === "trigger_fired") {
    addEvent(`[${msg.ptyId}] trigger ${msg.trigger}: ${msg.match}`);
    highlight(msg.ptyId, 2000);
    return;
  }
  if (msg.type === "pty_highlight") {
    highlight(msg.ptyId, msg.ttlMs);
    return;
  }
  if (msg.type === "trigger_error") {
    addEvent(`[${msg.ptyId}] trigger error ${msg.trigger}: ${msg.message}`);
    return;
  }
}

function tmuxSessionKey(s: TmuxSessionInfo): string {
  return `${s.server}:${s.name}`;
}

function selectedTmuxSession(): TmuxSessionInfo | null {
  const key = tmuxSessionSelect.value;
  if (!key) return null;
  return tmuxSessions.find((s) => tmuxSessionKey(s) === key) ?? null;
}

async function refreshTmuxSessions(): Promise<void> {
  const prev = tmuxSessionSelect.value;
  const res = await authFetch("/api/tmux/sessions", { cache: "no-store" });
  if (!res.ok) {
    addEvent(`Failed to list tmux sessions: ${await readApiError(res)}`);
    return;
  }
  const json = (await res.json()) as { sessions?: unknown };
  if (!Array.isArray(json.sessions)) {
    addEvent("Failed to parse tmux session list");
    return;
  }

  tmuxSessions = json.sessions as TmuxSessionInfo[];
  tmuxSessionSelect.textContent = "";

  if (tmuxSessions.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(no tmux sessions)";
    tmuxSessionSelect.appendChild(opt);
    tmuxSessionSelect.value = "";
    return;
  }

  for (const s of tmuxSessions) {
    const opt = document.createElement("option");
    opt.value = tmuxSessionKey(s);
    const stamp = s.createdAt ? new Date(s.createdAt).toLocaleTimeString() : "";
    const win = s.windows == null ? "" : `, ${s.windows}w`;
    opt.textContent = `${s.name} [${s.server}${win}]${stamp ? ` @ ${stamp}` : ""}`;
    tmuxSessionSelect.appendChild(opt);
  }
  tmuxSessionSelect.value = tmuxSessions.some((s) => tmuxSessionKey(s) === prev)
    ? prev
    : tmuxSessionKey(tmuxSessions[0]);
}

async function fetchTmuxSessionWarnings(selected: TmuxSessionInfo): Promise<string[]> {
  const qs = new URLSearchParams({
    name: selected.name,
    server: selected.server,
  });
  const res = await authFetch(`/api/tmux/check?${qs.toString()}`, { cache: "no-store" });
  if (!res.ok) {
    addEvent(`Failed to check tmux config: ${await readApiError(res)}`);
    return [];
  }
  const json = (await res.json()) as { checks?: TmuxSessionCheck };
  return Array.isArray(json.checks?.warnings) ? json.checks.warnings : [];
}

async function checkSelectedTmuxSessionAndMaybeWarn(): Promise<void> {
  const selected = selectedTmuxSession();
  if (!selected) return;
  const warnings = await fetchTmuxSessionWarnings(selected);
  if (warnings.length === 0) return;
  window.alert(
    `Selected tmux session has problematic settings:\n\n${warnings.map((w) => `- ${w}`).join("\n")}`,
  );
}

function addEvent(text: string): void {
  if (!eventsEl) return;
  const el = document.createElement("div");
  el.className = "event";
  el.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  eventsEl.prepend(el);
  while (eventsEl.children.length > 50) eventsEl.removeChild(eventsEl.lastElementChild!);
}

async function refreshList(): Promise<void> {
  try {
    const res = await authFetch("/api/ptys", { cache: "no-store" });
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
    const json = (await res.json()) as { ptys?: unknown };
    if (!Array.isArray(json.ptys)) {
      throw new Error("invalid PTY list response");
    }
    ptys = json.ptys as PtySummary[];
    updateTerminalVisibility();
    renderList();
  } catch (err) {
    addEvent(`Failed to refresh PTYs: ${errorMessage(err)}`);
  }
}

function hashHue(s: string): number {
  // Deterministic, cheap hash -> hue in [0, 359].
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function ptyColor(ptyId: string): string {
  return `hsl(${hashHue(ptyId)} ${activeTheme.hashSaturation}% ${activeTheme.hashLightness}%)`;
}

function shortId(ptyId: string): string {
  if (ptyId.length <= 14) return ptyId;
  return `${ptyId.slice(0, 6)}...${ptyId.slice(-6)}`;
}

function compactWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const AGENT_CHOICES = ["claude", "codex", "aider", "goose", "opencode", "cursor-agent"];

const shellProcessNames = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu"]);

function normalizeProcessName(s: string): string {
  const v = s.trim();
  if (!v) return "";
  return (v.split("/").filter(Boolean).at(-1) ?? v).toLowerCase();
}

function isShellProcess(s: string): boolean {
  return shellProcessNames.has(normalizeProcessName(s));
}

function truncateText(s: string, max = 68): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 3))}...`;
}

function appendPtyInputHistory(ptyId: string, input: string, bufferLine: number): void {
  const text = truncateText(input, 220);
  const prev = ptyInputHistory.get(ptyId) ?? [];
  if (prev.length > 0 && prev[prev.length - 1].text === text) return;
  const next = [...prev, { text, bufferLine }];
  if (next.length > MAX_INPUT_HISTORY) next.splice(0, next.length - MAX_INPUT_HISTORY);
  ptyInputHistory.set(ptyId, next);
}

function scrollToHistoryLine(ptyId: string, bufferLine: number): void {
  const st = terms.get(ptyId);
  if (!st || st.backend === "tmux") return;
  if (bufferLine <= 0) return;
  const buf = st.term.buffer.active;
  // If the line has been discarded from scrollback, do nothing.
  const firstAvailable = buf.length - (buf.baseY + st.term.rows);
  if (bufferLine < firstAvailable) return;
  st.term.scrollToLine(bufferLine);
}

function renderInputContextBar(): void {
  if (!activePtyId) {
    inputContextEl.classList.add("hidden");
    inputContextLastEl.textContent = "(none yet)";
    inputHistoryLabelEl.textContent = "History (0)";
    inputContextToggleEl.setAttribute("aria-expanded", "false");
    inputHistoryListEl.classList.add("hidden");
    inputHistoryListEl.textContent = "";
    return;
  }

  inputContextEl.classList.remove("hidden");

  const history = ptyInputHistory.get(activePtyId) ?? [];
  const lastEntry = history.length > 0 ? history[history.length - 1] : null;
  const latest = ptyLastInput.get(activePtyId) ?? lastEntry?.text ?? "(none yet)";
  inputContextLastEl.textContent = latest;
  inputContextLastEl.title = latest;

  // Make the "last input" element clickable to scroll to the most recent command.
  const lastPtyId = activePtyId;
  if (lastEntry && lastEntry.bufferLine > 0) {
    inputContextLastEl.classList.add("clickable");
    inputContextLastEl.onclick = () => scrollToHistoryLine(lastPtyId, lastEntry.bufferLine);
  } else {
    inputContextLastEl.classList.remove("clickable");
    inputContextLastEl.onclick = null;
  }

  inputHistoryLabelEl.textContent = `History (${history.length})`;
  inputContextToggleEl.setAttribute("aria-expanded", inputHistoryExpanded ? "true" : "false");

  if (!inputHistoryExpanded) {
    inputHistoryListEl.classList.add("hidden");
    return;
  }

  inputHistoryListEl.textContent = "";
  if (history.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No inputs yet";
    inputHistoryListEl.appendChild(li);
  } else {
    for (let i = 0; i < history.length; i++) {
      const entry = history[i];
      const li = document.createElement("li");
      li.textContent = entry.text;
      li.title = entry.text;
      if (entry.bufferLine > 0) {
        li.classList.add("clickable");
        const ptyId = activePtyId!;
        const line = entry.bufferLine;
        li.addEventListener("click", () => scrollToHistoryLine(ptyId, line));
      }
      inputHistoryListEl.appendChild(li);
    }
  }
  inputHistoryListEl.classList.remove("hidden");
}

function unquoteToken(s: string): string {
  if (s.length >= 2 && ((s.startsWith(`"`) && s.endsWith(`"`)) || (s.startsWith(`'`) && s.endsWith(`'`)))) {
    return s.slice(1, -1);
  }
  return s;
}

function inferProcessFromInput(line: string): string | null {
  const tokens = line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  if (!tokens.length) return null;

  const wrappers = new Set(["sudo", "env", "nohup", "time", "command"]);
  let i = 0;
  while (i < tokens.length) {
    const raw = unquoteToken(tokens[i]).trim();
    if (!raw) {
      i++;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(raw)) {
      i++;
      continue;
    }
    if (wrappers.has(raw) || raw === "--") {
      i++;
      continue;
    }
    let token = raw.replace(/^[({]+/, "").replace(/[;|&)}]+$/, "");
    if (!token) return null;
    if (token.includes("/")) token = token.split("/").filter(Boolean).at(-1) ?? token;
    if (!token) return null;
    return token;
  }
  return null;
}

function trackUserInput(ptyId: string, data: string): void {
  const cleaned = data
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b./g, "");

  const st = terms.get(ptyId);
  const buf = st?.term.buffer.active;
  let line = ptyInputLineBuffers.get(ptyId) ?? "";
  let changed = false;
  for (const ch of cleaned) {
    if (ch === "\r" || ch === "\n") {
      const normalized = compactWhitespace(line);
      if (normalized) {
        const bufferLine = buf ? buf.baseY + buf.cursorY : 0;
        ptyLastInput.set(ptyId, truncateText(normalized));
        appendPtyInputHistory(ptyId, normalized, bufferLine);
        const proc = inferProcessFromInput(normalized);
        if (proc) ptyInputProcessHints.set(ptyId, proc);
        changed = true;
      }
      line = "";
      continue;
    }
    if (ch === "\u007f" || ch === "\b") {
      line = line.slice(0, -1);
      continue;
    }
    if (ch === "\u0015") {
      line = "";
      continue;
    }
    if (ch < " ") continue;
    line += ch;
    if (line.length > 512) line = line.slice(-512);
  }
  ptyInputLineBuffers.set(ptyId, line);
  if (changed) {
    savePtyInputMeta(ptyId);
    renderList();
    renderInputContextBar();
  }
}

async function killPty(ptyId: string): Promise<void> {
  const res = await authFetch(`/api/ptys/${encodeURIComponent(ptyId)}/kill`, { method: "POST" });
  if (!res.ok) {
    addEvent(`Failed to kill PTY ${ptyId}: ${await readApiError(res)}`);
    return;
  }
  addEvent(`Killed PTY ${ptyId}`);

  if (activePtyId === ptyId) {
    activePtyId = null;
    saveActivePty(null);
  }
  removeTerm(ptyId);
  updateTerminalVisibility();

  await refreshList();
}

function normalizeCwdGroupKey(cwd: string): string {
  const idx = cwd.indexOf("/.worktrees/");
  if (idx !== -1) return cwd.slice(0, idx);
  return cwd;
}

function worktreeName(cwd: string | null): string | null {
  if (!cwd) return null;
  const m = cwd.match(/\/\.worktrees\/([^/]+)/);
  return m ? m[1] : null;
}

const collapsedGroups = new Set<string>();

function renderList(): void {
  listEl.textContent = "";

  // Group running PTYs by CWD (normalize .worktrees/ paths to parent repo)
  const grouped = new Map<string, PtySummary[]>();
  for (const p of ptys) {
    if (p.status !== "running") continue;
    const key = p.cwd ? normalizeCwdGroupKey(p.cwd) : "";
    let arr = grouped.get(key);
    if (!arr) {
      arr = [];
      grouped.set(key, arr);
    }
    arr.push(p);
  }

  // Sort: non-empty CWDs alphabetically by basename, empty last
  const sortedKeys = [...grouped.keys()].sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    const ba = a.split("/").filter(Boolean).at(-1) ?? a;
    const bb = b.split("/").filter(Boolean).at(-1) ?? b;
    return ba.localeCompare(bb);
  });

  const showHeaders = sortedKeys.length >= 1;

  for (const key of sortedKeys) {
    const collapsed = collapsedGroups.has(key);

    if (showHeaders) {
      const header = document.createElement("li");
      header.className = `pty-group-header${collapsed ? " collapsed" : ""}`;

      const chevron = document.createElement("span");
      chevron.className = "group-chevron";
      chevron.textContent = collapsed ? "\u25b6" : "\u25bc";
      header.appendChild(chevron);

      const label = document.createElement("span");
      if (key) {
        const basename = key.split("/").filter(Boolean).at(-1) ?? key;
        label.textContent = basename;
        header.title = key;
      } else {
        label.textContent = "Other";
      }
      header.appendChild(label);

      const launchBtn = document.createElement("button");
      launchBtn.className = "group-launch";
      launchBtn.textContent = "+";
      launchBtn.title = "Launch agent";
      launchBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openLaunchModal();
      });
      header.appendChild(launchBtn);

      header.addEventListener("click", () => {
        if (collapsedGroups.has(key)) collapsedGroups.delete(key);
        else collapsedGroups.add(key);
        renderList();
      });
      listEl.appendChild(header);
    }

    if (collapsed) continue;

    for (const p of grouped.get(key)!) {
      const li = document.createElement("li");
      li.className = "pty-item";
      li.dataset.ptyId = p.id;
      li.style.setProperty("--pty-color", ptyColor(p.id));
      if (p.id === activePtyId) li.classList.add("active");

      const row = document.createElement("div");
      row.className = "row";

      const main = document.createElement("div");
      main.className = "mainline";

      const title = (ptyTitles.get(p.id) ?? "").trim();
      const activeProcess = compactWhitespace(p.activeProcess ?? "");
      const process =
        (activeProcess && !isShellProcess(activeProcess) ? activeProcess : "") || activeProcess || title || p.name;
      const inputPreview = ptyLastInput.get(p.id) ?? "";
      const readyInfo = ptyReady.get(p.id) ?? readinessFromSummary(p);
      li.classList.add(`state-${readyInfo.state}`);
      const readyStateLabel = readyInfo.state;

      const primaryRow = document.createElement("div");
      primaryRow.className = "primary-row";

      const readyDot = document.createElement("span");
      readyDot.className = `ready-dot ${readyInfo.indicator}`;
      readyDot.title = `PTY is ${readyStateLabel}${readyInfo.reason ? ` (${readyInfo.reason})` : ""}`;
      readyDot.setAttribute("aria-label", `PTY is ${readyStateLabel}`);

      const primary = document.createElement("div");
      primary.className = "primary";
      primary.textContent = process;
      primaryRow.appendChild(readyDot);
      primaryRow.appendChild(primary);
      if (title && title !== process) {
        const titleEl = document.createElement("span");
        titleEl.className = "title-label";
        titleEl.textContent = title;
        titleEl.title = title;
        primaryRow.appendChild(titleEl);
      }

      const changedAt = ptyStateChangedAt.get(p.id);
      if (changedAt) {
        const elapsed = formatElapsedTime(changedAt);
        if (elapsed) {
          const timeBadge = document.createElement("span");
          timeBadge.className = `time-badge ${readyInfo.state === "ready" ? "ready" : "busy"}`;
          timeBadge.textContent = elapsed;
          timeBadge.title = readyInfo.state === "ready"
            ? `Ready for ${elapsed}`
            : `Processing for ${elapsed}`;
          primaryRow.appendChild(timeBadge);
        }
      }

      const secondary = document.createElement("div");
      secondary.className = "secondary";
      let secondaryText = "";
      if (inputPreview) {
        secondaryText = `> ${inputPreview}`;
      } else if (title && title !== process) {
        secondaryText = title;
      } else {
        secondaryText = p.name;
      }
      secondary.textContent = secondaryText;

      main.appendChild(primaryRow);
      main.appendChild(secondary);

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "pty-close";
      closeBtn.textContent = "x";
      closeBtn.title = "Close";
      closeBtn.setAttribute("aria-label", `Close PTY ${process}`);
      closeBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await killPty(p.id);
      });

      row.appendChild(main);
      row.appendChild(closeBtn);

      li.appendChild(row);

      // Compact dot for collapsed sidebar mode (hidden via CSS when expanded).
      const compactDot = document.createElement("span");
      compactDot.className = `ready-dot compact ${readyInfo.indicator}`;
      compactDot.title = `${process} — ${readyStateLabel}`;
      li.appendChild(compactDot);

      li.addEventListener("click", () => setActive(p.id));
      listEl.appendChild(li);
    }
  }
}

function setActive(ptyId: string): void {
  activePtyId = ptyId;
  saveActivePty(ptyId);
  const backend = ptys.find((p) => p.id === ptyId)?.backend;
  ensureTerm(ptyId, backend);
  updateTerminalVisibility();
  subscribeIfNeeded(ptyId);
  requestAnimationFrame(() => {
    fitAndResizeActive();
    reflowActiveTerm();
    const st = terms.get(ptyId);
    if (st) st.term.focus();
  });
  renderList();
  renderInputContextBar();
}

function highlight(ptyId: string, ttlMs: number): void {
  const el = listEl.querySelector(`[data-pty-id="${ptyId}"]`) as HTMLElement | null;
  if (!el) return;
  el.classList.add("highlight");
  setTimeout(() => el.classList.remove("highlight"), ttlMs);
}

async function newShell(): Promise<void> {
  const res = await authFetch("/api/ptys/shell", { method: "POST" });
  if (!res.ok) {
    addEvent(`Failed to create PTY: ${await readApiError(res)}`);
    return;
  }
  const json = (await res.json()) as { id: string };
  addEvent(`Created PTY ${json.id}`);
  await refreshList();
  refreshTmuxSessions().catch(() => {});
  setActive(json.id);
}

async function attachTmuxSession(selected: TmuxSessionInfo): Promise<void> {
  const existing = ptys.find(
    (p) => p.status === "running" && p.backend === "tmux" && (p.tmuxSession ?? "") === selected.name,
  );
  if (existing) {
    addEvent(`Using existing tmux ${selected.name}`);
    setActive(existing.id);
    return;
  }
  const res = await authFetch("/api/ptys/attach-tmux", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ name: selected.name, server: selected.server }),
  });
  if (!res.ok) {
    addEvent(`Failed to attach tmux ${selected.name}: ${await readApiError(res)}`);
    return;
  }
  const json = (await res.json()) as { id: string };
  addEvent(`Attached tmux ${selected.name}`);
  await refreshList();
  setActive(json.id);
}

btnNew.addEventListener("click", () => {
  newShell().catch(() => {
    // ignore
  });
});

tmuxSessionSelect.addEventListener("change", () => {
  const selected = selectedTmuxSession();
  if (!selected) return;
  checkSelectedTmuxSessionAndMaybeWarn()
    .then(() => attachTmuxSession(selected))
    .catch((err) => {
      addEvent(`Attach tmux failed: ${errorMessage(err)}`);
    });
});

tmuxSessionSelect.addEventListener("focus", () => {
  refreshTmuxSessions().catch((err) => {
    addEvent(`Failed to refresh tmux sessions: ${errorMessage(err)}`);
  });
});


function toggleInputHistory(): void {
  if (!activePtyId) return;
  inputHistoryExpanded = !inputHistoryExpanded;
  renderInputContextBar();
}

inputContextToggleEl.addEventListener("click", () => {
  toggleInputHistory();
});

inputContextToggleEl.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" && ev.key !== " ") return;
  ev.preventDefault();
  toggleInputHistory();
});

function subscribeIfNeeded(ptyId: string): void {
  if (subscribed.has(ptyId)) return;
  subscribed.add(ptyId);
  sendWsMessage({ type: "subscribe", ptyId });
}

// Force xterm.js to reflow the active terminal buffer.  A plain refresh()
// only re-renders the viewport without recalculating line wrapping, which
// leaves garbled output after reconnects and resizes.  Scrolling by +1/−1
// triggers a full reflow just like a manual wheel scroll.
function reflowActiveTerm(): void {
  if (!activePtyId) return;
  const st = terms.get(activePtyId);
  if (!st) return;
  st.term.scrollLines(-1);
  st.term.scrollLines(1);
}

function updateTerminalVisibility(): void {
  const hasActive = Boolean(activePtyId);
  placeholderEl.classList.toggle("hidden", hasActive);
  renderInputContextBar();
  for (const [ptyId, st] of terms.entries()) {
    st.container.classList.toggle("hidden", !hasActive || ptyId !== activePtyId);
  }
}

function fitAndResizeActive(): void {
  if (!activePtyId) return;
  const st = terms.get(activePtyId);
  if (!st) return;

  st.fit.fit();

  const cols = st.term.cols;
  const rows = st.term.rows;
  if (cols <= 0 || rows <= 0) return;
  if (st.lastResize && st.lastResize.cols === cols && st.lastResize.rows === rows) return;

  st.lastResize = { cols, rows };
  sendWsMessage({ type: "resize", ptyId: activePtyId, cols, rows });
}

const ro = new ResizeObserver(() => {
  requestAnimationFrame(() => { fitAndResizeActive(); reflowActiveTerm(); });
});
ro.observe(terminalEl);
window.addEventListener("resize", () => { fitAndResizeActive(); reflowActiveTerm(); });

// --- Keybindings ---

function runningPtys(): PtySummary[] {
  return ptys.filter((p) => p.status === "running");
}

function switchPtyByOffset(offset: number): void {
  const running = runningPtys();
  if (running.length === 0) return;
  const idx = running.findIndex((p) => p.id === activePtyId);
  const next = (idx + offset + running.length) % running.length;
  setActive(running[next].id);
}

function switchToNextReady(): void {
  const running = runningPtys();
  if (running.length === 0) return;
  const idx = Math.max(0, running.findIndex((p) => p.id === activePtyId));
  for (let i = 1; i <= running.length; i++) {
    const candidate = running[(idx + i) % running.length];
    const readyInfo = ptyReady.get(candidate.id);
    if (readyInfo?.state === "ready") {
      setActive(candidate.id);
      return;
    }
  }
}

document.addEventListener(
  "keydown",
  (ev: KeyboardEvent) => {
    if (!ev.ctrlKey || !ev.shiftKey || ev.altKey || ev.metaKey) return;
    switch (ev.code) {
      case "BracketRight":
        ev.preventDefault();
        ev.stopPropagation();
        switchPtyByOffset(1);
        return;
      case "BracketLeft":
        ev.preventDefault();
        ev.stopPropagation();
        switchPtyByOffset(-1);
        return;
      case "Backquote":
        ev.preventDefault();
        ev.stopPropagation();
        newShell().catch(() => {});
        return;
      case "KeyQ":
        ev.preventDefault();
        ev.stopPropagation();
        if (activePtyId) killPty(activePtyId).catch(() => {});
        return;
      case "Space":
        ev.preventDefault();
        ev.stopPropagation();
        switchToNextReady();
        return;
    }
  },
  { capture: true },
);

// --- Keybindings popup ---

const btnKeys = $("btn-keys") as HTMLButtonElement;

const keysBackdrop = document.createElement("div");
keysBackdrop.className = "keys-backdrop hidden";
document.body.appendChild(keysBackdrop);

const keysPopup = document.createElement("div");
keysPopup.className = "keys-popup hidden";
keysPopup.innerHTML = `
  <div class="keys-popup-title">Keybindings</div>
  <table>
    <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>\`</kbd></td><td>New shell</td></tr>
    <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Q</kbd></td><td>Close PTY</td></tr>
    <tr><td>Select text</td><td>Copy to clipboard</td></tr>
    <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>]</kbd></td><td>Next PTY</td></tr>
    <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>[</kbd></td><td>Previous PTY</td></tr>
    <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd></td><td>Next ready PTY</td></tr>
  </table>`;
document.body.appendChild(keysPopup);

function toggleKeysPopup(): void {
  const show = keysPopup.classList.contains("hidden");
  keysPopup.classList.toggle("hidden", !show);
  keysBackdrop.classList.toggle("hidden", !show);
}

btnKeys.addEventListener("click", toggleKeysPopup);
keysBackdrop.addEventListener("click", toggleKeysPopup);
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !keysPopup.classList.contains("hidden")) {
    toggleKeysPopup();
  }
});

void (async () => {
  try {
    await fetchSessionToken();
    await loadPtyInputMeta();
    connectWs();
    btnNew.disabled = false;
    await refreshTmuxSessions();
  } catch (err) {
    addEvent(`Failed to initialize session: ${errorMessage(err)}`);
  }
  await refreshList();

  // Restore previously active PTY for this browser tab.
  if (!activePtyId) {
    const saved = loadSavedActivePty();
    if (saved) {
      const running = ptys.filter((p) => p.status === "running");
      const target =
        running.find((p) => p.id === saved.ptyId) ??
        (saved.tmuxSession
          ? running.find((p) => p.backend === "tmux" && p.tmuxSession === saved.tmuxSession)
          : null);
      if (target) setActive(target.id);
    }
  }
})();

// Refresh sidebar every 5 seconds to keep time badges current.
setInterval(() => renderList(), 5000);

// Minimal debug hooks for e2e tests and local inspection.
function dumpBuffer(st: TermState, maxLines = 120): string {
  const out: string[] = [];
  const buf = st.term.buffer.active;
  const start = Math.max(0, buf.length - maxLines);
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    out.push(line.translateToString(true));
  }
  return out.join("\n");
}

(window as any).__agentTide = {
  activePtyId: () => activePtyId,
  dumpActive: () => {
    if (!activePtyId) return "";
    const st = terms.get(activePtyId);
    if (!st) return "";
    return dumpBuffer(st);
  },
  bufferActiveInfo: () => {
    if (!activePtyId) return { baseY: 0, viewportY: 0, length: 0, rows: 0 };
    const st = terms.get(activePtyId);
    if (!st) return { baseY: 0, viewportY: 0, length: 0, rows: 0 };
    const b = st.term.buffer.active;
    const rawBaseY = (b as unknown as { baseY?: unknown }).baseY;
    const rawViewportY = (b as unknown as { viewportY?: unknown }).viewportY;
    const baseY = typeof rawBaseY === "number" ? rawBaseY : Math.max(0, b.length - st.term.rows);
    const viewportY = typeof rawViewportY === "number" ? rawViewportY : baseY;
    return {
      baseY,
      viewportY,
      length: b.length,
      rows: st.term.rows,
    };
  },
  dumpViewport: () => {
    if (!activePtyId) return "";
    const st = terms.get(activePtyId);
    if (!st) return "";
    const buf = st.term.buffer.active;
    const rawViewportY = (buf as unknown as { viewportY?: unknown }).viewportY;
    const start = typeof rawViewportY === "number" ? rawViewportY : Math.max(0, buf.length - st.term.rows);
    const end = start + st.term.rows;
    const lines: string[] = [];
    for (let i = start; i < end; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      lines.push(line.translateToString(true));
    }
    return lines.join("\n");
  },
  scrollToBottomActive: () => {
    if (!activePtyId) return;
    const st = terms.get(activePtyId);
    if (!st) return;
    st.term.scrollToBottom();
  },
};
