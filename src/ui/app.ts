import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { THEMES, DEFAULT_THEME_KEY, applyTheme, type Theme } from "./themes";
import {
  renderPtyList,
  type InactivePtyItem,
  type InactiveWorktreeSubgroup,
  type PtyGroup,
  type PtyListModel,
  type RunningPtyItem,
  type WorktreeSubgroup,
} from "./pty-list-view";
import {
  renderLaunchModal,
  type LaunchModalViewModel,
  type LaunchOptionControl,
} from "./launch-modal-view";
import {
  renderCloseWorktreeModal,
  type CloseWorktreeModalViewModel,
} from "./close-worktree-modal-view";
import {
  renderRestoreSessionModal,
  type RestoreSessionModalViewModel,
  type RestoreTargetChoice,
} from "./restore-session-modal-view";
import {
  renderSettingsModal,
  type SettingsModalViewModel,
} from "./settings-modal-view";

type PtyReadinessState = "ready" | "busy" | "unknown";
type PtyReadinessIndicator = "ready" | "busy";

type PtySummary = {
  id: string;
  name: string;
  tmuxSession?: string | null;
  tmuxServer?: "agmux" | "default" | null;
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
  lastSeenAt?: number;
  status: "running" | "exited";
  exitCode?: number | null;
  exitSignal?: string | null;
};

type AgentSessionSummary = {
  id: string;
  provider: "claude" | "codex" | "pi";
  providerSessionId: string;
  name: string;
  command: string;
  args: string[];
  cwd: string | null;
  cwdSource: "runtime" | "db" | "log" | "user";
  projectRoot: string | null;
  worktree: string | null;
  createdAt: number;
  lastSeenAt: number;
  lastRestoredAt?: number | null;
};

type TmuxSessionInfo = {
  name: string;
  server: "agmux" | "default";
  createdAt: number | null;
  windows: number | null;
};

type TmuxSessionCheck = {
  name: string;
  server: "agmux" | "default";
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
      activeProcess?: string | null;
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
let agentSessions: AgentSessionSummary[] = [];
let activePtyId: string | null = null;
let pendingActivePtyId: string | null = null;
let inputHistoryExpanded = false;

// Client-side worktree cache, populated from GET /api/worktrees
let knownWorktrees: Array<{ name: string; path: string; branch: string }> = [];
let serverRepoRoot = "";

const ACTIVE_PTY_KEY = "agmux:activePty";
const AUTH_TOKEN_KEY = "agmux:authToken";
const HIDDEN_AGENT_SESSIONS_KEY = "agmux:hiddenAgentSessions";
const PINNED_DIRECTORIES_KEY = "agmux:pinnedDirectories";
const ARCHIVED_DIRECTORIES_KEY = "agmux:archivedDirectories";
const hiddenAgentSessionIds = new Set<string>();
const pinnedDirectories = new Set<string>();
const archivedDirectories = new Set<string>();

function loadHiddenAgentSessions(): void {
  try {
    const raw = localStorage.getItem(HIDDEN_AGENT_SESSIONS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const value of parsed) {
      if (typeof value === "string" && value.trim().length > 0) {
        hiddenAgentSessionIds.add(value);
      }
    }
  } catch {
    // ignore
  }
}

function saveHiddenAgentSessions(): void {
  try {
    localStorage.setItem(HIDDEN_AGENT_SESSIONS_KEY, JSON.stringify([...hiddenAgentSessionIds]));
  } catch {
    // ignore
  }
}

function loadPinnedDirectories(): void {
  try {
    const raw = localStorage.getItem(PINNED_DIRECTORIES_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const value of parsed) {
      if (typeof value === "string" && value.trim().length > 0) {
        pinnedDirectories.add(value);
      }
    }
  } catch {
    // ignore
  }
}

function savePinnedDirectories(): void {
  try {
    localStorage.setItem(PINNED_DIRECTORIES_KEY, JSON.stringify([...pinnedDirectories]));
  } catch {
    // ignore
  }
}

function loadArchivedDirectories(): void {
  try {
    const raw = localStorage.getItem(ARCHIVED_DIRECTORIES_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const value of parsed) {
      if (typeof value === "string" && value.trim().length > 0) {
        archivedDirectories.add(value);
      }
    }
  } catch {
    // ignore
  }
}

function saveArchivedDirectories(): void {
  try {
    localStorage.setItem(ARCHIVED_DIRECTORIES_KEY, JSON.stringify([...archivedDirectories]));
  } catch {
    // ignore
  }
}

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
        tmuxServer: p?.tmuxServer ?? null,
      }),
    );
    // Cleanup legacy shared storage value from older builds.
    localStorage.removeItem(ACTIVE_PTY_KEY);
  } catch {
    // ignore storage failures
  }
}

function loadSavedActivePty(): { ptyId: string; tmuxSession: string | null; tmuxServer: "agmux" | "default" | null } | null {
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
    return typeof v.ptyId === "string"
      ? {
        ptyId: v.ptyId,
        tmuxSession: v.tmuxSession ?? null,
        tmuxServer: v.tmuxServer === "default" ? "default" : v.tmuxServer === "agmux" ? "agmux" : null,
      }
      : null;
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

loadHiddenAgentSessions();
loadPinnedDirectories();
loadArchivedDirectories();

async function refreshWorktreeCache(): Promise<void> {
  try {
    const res = await authFetch("/api/worktrees");
    if (!res.ok) return;
    const data = (await res.json()) as {
      worktrees?: Array<{ name: string; path: string; branch: string }>;
      repoRoot?: string;
    };
    if (Array.isArray(data.worktrees)) knownWorktrees = data.worktrees;
    if (typeof data.repoRoot === "string") serverRepoRoot = data.repoRoot;
  } catch {
    // ignore
  }
}

// Periodically refresh worktree cache
setInterval(() => void refreshWorktreeCache(), 30_000);

// Cache of directory existence checks, refreshed on each PTY list update.
const directoryExistsCache = new Map<string, boolean>();
let directoryExistsCheckInFlight = false;

async function checkDirectoryExistence(dirs: string[]): Promise<void> {
  if (directoryExistsCheckInFlight) return;
  directoryExistsCheckInFlight = true;
  try {
    for (const dir of dirs) {
      if (!dir) continue;
      try {
        const res = await authFetch(`/api/directory-exists?path=${encodeURIComponent(dir)}`);
        if (res.ok) {
          const json = (await res.json()) as { exists: boolean };
          directoryExistsCache.set(dir, json.exists);
        }
      } catch {
        // ignore individual failures
      }
    }
  } finally {
    directoryExistsCheckInFlight = false;
  }
}

function autoArchiveMissingDirectories(): void {
  let changed = false;
  for (const dir of [...pinnedDirectories]) {
    if (!dir) continue;
    const exists = directoryExistsCache.get(dir);
    if (exists === false) {
      // Only auto-archive if no running PTYs use this directory
      const hasRunning = ptys.some(
        (p) => p.status === "running" && p.cwd && normalizeCwdGroupKey(p.cwd) === dir,
      );
      if (!hasRunning) {
        pinnedDirectories.delete(dir);
        archivedDirectories.add(dir);
        changed = true;
      }
    }
  }
  if (changed) {
    savePinnedDirectories();
    saveArchivedDirectories();
  }
}

function archiveDirectory(groupKey: string): void {
  pinnedDirectories.delete(groupKey);
  archivedDirectories.add(groupKey);
  savePinnedDirectories();
  saveArchivedDirectories();
  renderList();
}

function unarchiveDirectory(groupKey: string): void {
  archivedDirectories.delete(groupKey);
  saveArchivedDirectories();
  renderList();
}

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

// Prevent sidebar clicks from stealing keyboard focus from the terminal.
document.querySelector(".sidebar")!.addEventListener("mousedown", (ev) => {
  const tag = (ev.target as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  ev.preventDefault();
});

// --- Theme ---

const THEME_KEY = "agmux:theme";
let activeThemeKey = localStorage.getItem(THEME_KEY) ?? DEFAULT_THEME_KEY;
let activeTheme: Theme = THEMES.get(activeThemeKey) ?? THEMES.get(DEFAULT_THEME_KEY)!;

// Apply theme to CSS vars immediately (before any terminal creation).
applyTheme(activeTheme, []);

function setTheme(key: string): void {
  const next = THEMES.get(key);
  if (!next) return;
  activeThemeKey = key;
  activeTheme = next;
  localStorage.setItem(THEME_KEY, activeThemeKey);
  applyTheme(activeTheme, terms.values());
  renderList();
  focusActiveTerm();
}

type TermState = {
  ptyId: string;
  container: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  lastResize: { cols: number; rows: number } | null;
};

const terms = new Map<string, TermState>();
const subscribed = new Set<string>();
let authToken = "";
let ws: WebSocket | null = null;
const TERMINAL_SCROLLBACK_LINES = 0;
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

  setInterval(() => void tick(), 1500);
  void tick();
}

function createTermState(ptyId: string): TermState {
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
    scrollback: TERMINAL_SCROLLBACK_LINES,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(container);

  // Intercept wheel events and scroll tmux history instead.
  container.addEventListener(
    "wheel",
    (ev) => {
      if (ev.ctrlKey) return;
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

  return { ptyId, container, term, fit, lastResize: null };
}

function ensureTerm(ptyId: string): TermState {
  const existing = terms.get(ptyId);
  if (existing) return existing;
  const created = createTermState(ptyId);
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
  if (authToken) headers.set("x-agmux-token", authToken);
  return headers;
}

async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: authHeaders(init?.headers),
  });
}

let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsReconnectDelay = 0;
const WS_RECONNECT_BASE = 500;
const WS_RECONNECT_MAX = 10_000;

function scheduleWsReconnect(): void {
  if (wsReconnectTimer !== null) return;
  wsReconnectDelay = wsReconnectDelay === 0
    ? WS_RECONNECT_BASE
    : Math.min(wsReconnectDelay * 2, WS_RECONNECT_MAX);
  addEvent(`WS reconnecting in ${wsReconnectDelay}ms…`);
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWs();
  }, wsReconnectDelay);
}

function connectWs(): void {
  ws = new WebSocket(wsUrl());

  ws.addEventListener("open", () => {
    wsReconnectDelay = 0;
    addEvent(`WS connected`);
    for (const ptyId of subscribed) {
      sendWsMessage({ type: "subscribe", ptyId });
    }
    refreshList();
  });

  ws.addEventListener("close", () => {
    addEvent(`WS disconnected`);
    scheduleWsReconnect();
  });

  ws.addEventListener("error", () => {
    // close will fire after error, triggering reconnect
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

function setAuthToken(token: string): void {
  authToken = token;
  try {
    sessionStorage.setItem(AUTH_TOKEN_KEY, token);
  } catch {
    // ignore storage failures
  }
  try {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
  } catch {
    // ignore storage failures
  }
}

async function ensureAuthToken(): Promise<void> {
  const qs = new URLSearchParams(location.search);
  const tokenFromUrl = qs.get("token")?.trim() ?? "";
  if (tokenFromUrl) {
    setAuthToken(tokenFromUrl);
    return;
  }

  const tokenFromSession = sessionStorage.getItem(AUTH_TOKEN_KEY)?.trim() ?? "";
  const tokenFromLocal = localStorage.getItem(AUTH_TOKEN_KEY)?.trim() ?? "";
  const tokenFromStorage = tokenFromSession || tokenFromLocal;
  if (tokenFromStorage) {
    authToken = tokenFromStorage;
    return;
  }

  // Auth is opt-in. Probe once: if API works without token, skip prompt.
  // If API returns 401, a token is required for this server instance.
  try {
    const probe = await fetch("/api/ptys", { cache: "no-store" });
    if (probe.status !== 401) {
      return;
    }
  } catch {
    // Ignore probe failures; we'll fall back to prompting.
  }

  const entered = window.prompt(
    "Enter AGMUX token.\nIf AGMUX_TOKEN_ENABLED=1 and the token was auto-generated, check the server log for '[agmux] Token: ...'.",
  );
  const token = entered?.trim() ?? "";
  if (!token) {
    throw new Error("AGMUX token is required");
  }
  setAuthToken(token);
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

// Use ETag-based asset reload poller as the sole reload mechanism.
startAssetReloadPoller();

function onServerMsg(msg: ServerMsg): void {
  if (msg.type === "pty_list") {
    ptys = msg.ptys;
    if (activePtyId) {
      const active = ptys.find((p) => p.id === activePtyId);
      if (!active || active.status !== "running") {
        // PTY ID disappeared (e.g. server restart assigned new IDs).
        // Try to re-match by tmux session identity before giving up.
        const saved = loadSavedActivePty();
        const runningPtys = ptys.filter((p) => p.status === "running");
        const fallback = saved?.tmuxSession
          ? runningPtys.find(
            (p) =>
              p.backend === "tmux" &&
              p.tmuxSession === saved.tmuxSession &&
              (saved.tmuxServer ? p.tmuxServer === saved.tmuxServer : true),
          )
          : null;
        if (fallback) {
          activePtyId = fallback.id;
          saveActivePty(fallback.id);
        } else {
          activePtyId = null;
          saveActivePty(null);
        }
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

    if (pendingActivePtyId) {
      const pending = ptys.find((p) => p.id === pendingActivePtyId);
      if (pending && pending.status === "running") {
        setActive(pendingActivePtyId);
      }
    }

    updateTerminalVisibility();
    reflowActiveTerm();
    renderList();

    // Check directory existence for pinned dirs and inactive session dirs without running PTYs
    const allSessionDirs = new Set<string>(pinnedDirectories);
    for (const s of agentSessions) {
      const key = s.projectRoot ?? (s.cwd ? normalizeCwdGroupKey(s.cwd) : null);
      if (key) allSessionDirs.add(key);
    }
    const dirsToCheck = [...allSessionDirs].filter((d) => {
      if (!d) return false;
      if (directoryExistsCache.has(d)) return false;
      return !ptys.some((p) => p.status === "running" && p.cwd && normalizeCwdGroupKey(p.cwd) === d);
    });
    if (dirsToCheck.length > 0) {
      void checkDirectoryExistence(dirsToCheck).then(() => {
        autoArchiveMissingDirectories();
        renderList();
      });
    }

    return;
  }
  if (msg.type === "pty_output") {
    const st = ensureTerm(msg.ptyId);
    st.term.write(msg.data);
    if (msg.ptyId === activePtyId) scheduleReflow();
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
    const p = ptys.find((x) => x.id === msg.ptyId);
    if (p) {
      if (msg.cwd != null) p.cwd = msg.cwd;
      if (msg.activeProcess !== undefined) p.activeProcess = msg.activeProcess;
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
    const [ptysRes, sessionsRes] = await Promise.all([
      authFetch("/api/ptys", { cache: "no-store" }),
      authFetch("/api/agent-sessions", { cache: "no-store" }),
    ]);

    if (!ptysRes.ok) {
      throw new Error(await readApiError(ptysRes));
    }
    const ptysJson = (await ptysRes.json()) as { ptys?: unknown };
    if (!Array.isArray(ptysJson.ptys)) {
      throw new Error("invalid PTY list response");
    }
    ptys = ptysJson.ptys as PtySummary[];

    if (sessionsRes.ok) {
      const sessionsJson = (await sessionsRes.json()) as { sessions?: unknown };
      if (Array.isArray(sessionsJson.sessions)) {
        agentSessions = sessionsJson.sessions as AgentSessionSummary[];
      } else {
        agentSessions = [];
      }
    } else {
      agentSessions = [];
      addEvent(`Failed to refresh agent sessions: ${await readApiError(sessionsRes)}`);
    }

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

const AGENT_CHOICES = ["claude", "codex", "aider", "goose", "opencode", "cursor-agent", "shell"];

type OptionDef =
  | { type: "select"; flag: string; label: string; choices: { value: string; label: string }[]; defaultValue: string }
  | { type: "checkbox"; flag: string; label: string; defaultChecked: boolean };

/** Per-agent launch options, matching the actual CLI flags. */
const AGENT_OPTIONS: Record<string, OptionDef[]> = {
  claude: [
    {
      type: "select", flag: "--permission-mode", label: "Permission mode",
      defaultValue: "default",
      choices: [
        { value: "default", label: "default" },
        { value: "acceptEdits", label: "acceptEdits" },
        { value: "bypassPermissions", label: "bypassPermissions" },
        { value: "plan", label: "plan" },
      ],
    },
    { type: "checkbox", flag: "--dangerously-skip-permissions", label: "--dangerously-skip-permissions", defaultChecked: true },
  ],
  codex: [
    {
      type: "select", flag: "--ask-for-approval", label: "Ask for approval",
      defaultValue: "on-request",
      choices: [
        { value: "untrusted", label: "untrusted" },
        { value: "on-failure", label: "on-failure" },
        { value: "on-request", label: "on-request" },
        { value: "never", label: "never" },
      ],
    },
    {
      type: "select", flag: "--sandbox", label: "Sandbox",
      defaultValue: "workspace-write",
      choices: [
        { value: "read-only", label: "read-only" },
        { value: "workspace-write", label: "workspace-write" },
        { value: "danger-full-access", label: "danger-full-access" },
      ],
    },
    { type: "checkbox", flag: "--full-auto", label: "--full-auto", defaultChecked: true },
    { type: "checkbox", flag: "--dangerously-bypass-approvals-and-sandbox", label: "--dangerously-bypass-approvals-and-sandbox", defaultChecked: false },
  ],
};

function generateBranchName(): string {
  const verbs = [
    "build", "craft", "debug", "patch", "tune", "refine", "shape", "forge", "spark", "wire",
    "mend", "hone", "trace", "carve", "weave", "align", "fuse", "solve", "twist", "stitch",
    "sand", "temper", "splice", "prime", "sift", "grind", "weld", "buff", "etch", "mold",
  ];
  const nouns = [
    "otter", "falcon", "comet", "maple", "cedar", "harbor", "reef", "prism", "flint", "ridge",
    "heron", "quartz", "ember", "thorn", "birch", "delta", "summit", "dusk", "grove", "crest",
    "pike", "frost", "anvil", "cairn", "drift", "glyph", "vale", "shard", "moss", "blaze",
  ];
  const verb = verbs[Math.floor(Math.random() * verbs.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${verb}-${noun}`;
}

type WorktreeOption = { value: string; label: string };

type LaunchModalState = {
  selectedAgent: string;
  directoryOptions: { value: string; label: string }[];
  selectedDirectory: string;
  customDirectoryValue: string;
  selectedWorktree: string;
  branchValue: string;
  baseBranchValue: string;
  generatedBranch: string;
  launching: boolean;
  savedFlags: Record<string, Record<string, string | boolean>>;
  worktreeOptions: WorktreeOption[];
  projectRoot: string;
};

const launchModalRoot = document.createElement("div");
document.body.appendChild(launchModalRoot);
let launchModalState: LaunchModalState | null = null;
let launchModalSeq = 0;
let customDirRefreshTimer: ReturnType<typeof setTimeout> | undefined;
const NOOP_LAUNCH_HANDLERS = {
  onClose: () => {},
  onAgentChange: () => {},
  onOptionChange: () => {},
  onDirectoryChange: () => {},
  onCustomDirectoryChange: () => {},
  onWorktreeChange: () => {},
  onBranchChange: () => {},
  onBaseBranchChange: () => {},
  onLaunch: () => {},
};

function buildWorktreeOptions(
  groupCwd: string,
  worktrees?: Array<{ name: string; path: string }>,
): WorktreeOption[] {
  const options: WorktreeOption[] = [{ value: "__new__", label: "+ New worktree" }];
  if (groupCwd) {
    const name = groupCwd.split("/").filter(Boolean).at(-1) ?? groupCwd;
    options.push({ value: groupCwd, label: `Current (${name})` });
  }
  if (Array.isArray(worktrees)) {
    for (const wt of worktrees) {
      if (!wt || typeof wt.path !== "string" || typeof wt.name !== "string") continue;
      if (groupCwd && wt.path === groupCwd) continue;
      options.push({ value: wt.path, label: wt.name });
    }
  }
  return options;
}

function buildDirectoryOptions(): { value: string; label: string }[] {
  const dirs = new Set<string>();
  // Add all active group keys: pinned dirs + dirs with running PTYs
  for (const dir of pinnedDirectories) {
    if (dir && !archivedDirectories.has(dir)) dirs.add(dir);
  }
  for (const p of ptys) {
    if (p.status === "running" && p.cwd) {
      const key = normalizeCwdGroupKey(p.cwd);
      if (key && !archivedDirectories.has(key)) dirs.add(key);
    }
  }
  const sorted = [...dirs].sort((a, b) => {
    const ba = a.split("/").filter(Boolean).at(-1) ?? a;
    const bb = b.split("/").filter(Boolean).at(-1) ?? b;
    return ba.localeCompare(bb);
  });
  const options = sorted.map((d) => ({
    value: d,
    label: d.split("/").filter(Boolean).at(-1) ?? d,
  }));
  options.push({ value: "__custom__", label: "Custom path..." });
  return options;
}

function getEffectiveProjectRoot(state: LaunchModalState): string {
  if (state.selectedDirectory === "__custom__") return state.customDirectoryValue;
  return state.selectedDirectory;
}

function buildLaunchOptionControls(state: LaunchModalState): LaunchOptionControl[] {
  const defs = AGENT_OPTIONS[state.selectedAgent] ?? [];
  const saved = state.savedFlags[state.selectedAgent] ?? {};
  return defs.map((def) =>
    def.type === "select"
      ? {
        type: "select",
        flag: def.flag,
        label: def.label,
        value: typeof saved[def.flag] === "string" ? String(saved[def.flag]) : def.defaultValue,
        choices: def.choices,
      }
      : {
        type: "checkbox",
        flag: def.flag,
        label: def.label,
        checked: typeof saved[def.flag] === "boolean" ? Boolean(saved[def.flag]) : def.defaultChecked,
      });
}

function closeLaunchModal(): void {
  launchModalState = null;
  renderLaunchModal(launchModalRoot, null, NOOP_LAUNCH_HANDLERS);
}

function renderLaunchModalState(): void {
  const state = launchModalState;
  const effectiveRoot = state ? getEffectiveProjectRoot(state) : "";
  const model: LaunchModalViewModel | null = state
    ? {
      agentChoices: AGENT_CHOICES,
      selectedAgent: state.selectedAgent,
      optionControls: buildLaunchOptionControls(state),
      directoryOptions: state.directoryOptions,
      selectedDirectory: state.selectedDirectory,
      customDirectoryValue: state.customDirectoryValue,
      worktreeOptions: state.worktreeOptions,
      selectedWorktree: state.selectedWorktree,
      branchValue: state.branchValue,
      branchPlaceholder: state.generatedBranch,
      baseBranchValue: state.baseBranchValue,
      launching: state.launching,
      projectName: effectiveRoot ? effectiveRoot.split("/").pop() : undefined,
    }
    : null;

  renderLaunchModal(launchModalRoot, model, {
    onClose: () => closeLaunchModal(),
    onAgentChange: (agent) => {
      if (!launchModalState) return;
      launchModalState.selectedAgent = agent;
      renderLaunchModalState();
    },
    onOptionChange: (flag, value) => {
      if (!launchModalState) return;
      const agentFlags = launchModalState.savedFlags[launchModalState.selectedAgent] ?? {};
      agentFlags[flag] = value;
      launchModalState.savedFlags[launchModalState.selectedAgent] = agentFlags;
      renderLaunchModalState();
    },
    onDirectoryChange: (dir) => {
      if (!launchModalState) return;
      launchModalState.selectedDirectory = dir;
      launchModalState.projectRoot = dir === "__custom__" ? launchModalState.customDirectoryValue : dir;
      renderLaunchModalState();
      // Re-fetch worktrees and default branch for the new directory
      const effectiveRoot = getEffectiveProjectRoot(launchModalState);
      if (effectiveRoot) {
        refreshLaunchModalForDirectory(effectiveRoot);
      }
    },
    onCustomDirectoryChange: (pathValue) => {
      if (!launchModalState) return;
      launchModalState.customDirectoryValue = pathValue;
      launchModalState.projectRoot = pathValue;
      renderLaunchModalState();
      // Debounce directory refresh for custom path
      clearTimeout(customDirRefreshTimer);
      customDirRefreshTimer = setTimeout(() => {
        if (!launchModalState || launchModalState.selectedDirectory !== "__custom__") return;
        const dir = launchModalState.customDirectoryValue.trim();
        if (dir) refreshLaunchModalForDirectory(dir);
      }, 500);
    },
    onWorktreeChange: (worktree) => {
      if (!launchModalState) return;
      launchModalState.selectedWorktree = worktree;
      renderLaunchModalState();
    },
    onBranchChange: (branch) => {
      if (!launchModalState) return;
      launchModalState.branchValue = branch;
      renderLaunchModalState();
    },
    onBaseBranchChange: (baseBranch) => {
      if (!launchModalState) return;
      launchModalState.baseBranchValue = baseBranch;
      renderLaunchModalState();
    },
    onLaunch: () => {
      if (!launchModalState || launchModalState.launching) return;
      const stateNow = launchModalState;
      if (!stateNow.selectedAgent || !stateNow.selectedWorktree) return;
      stateNow.launching = true;
      renderLaunchModalState();

      const branch = stateNow.selectedWorktree === "__new__"
        ? (stateNow.branchValue.trim() || stateNow.generatedBranch)
        : undefined;
      const baseBranch = stateNow.selectedWorktree === "__new__"
        ? (stateNow.baseBranchValue.trim() || "main")
        : undefined;
      const flags = stateNow.savedFlags[stateNow.selectedAgent] ?? {};
      const effectiveProjectRoot = getEffectiveProjectRoot(stateNow);

      void authFetch("/api/ptys/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: stateNow.selectedAgent,
          worktree: stateNow.selectedWorktree,
          branch,
          baseBranch,
          flags,
          projectRoot: effectiveProjectRoot || undefined,
        }),
      })
        .then(async (res) => {
          if (res.ok) {
            const { id } = await res.json() as { id: string };
            closeLaunchModal();
            setActive(id);
            return;
          }
          const msg = await readApiError(res);
          throw new Error(msg || "Launch failed");
        })
        .catch((err) => {
          if (!launchModalState) return;
          launchModalState.launching = false;
          renderLaunchModalState();
          window.alert(errorMessage(err));
        });
    },
  });
}

function refreshLaunchModalForDirectory(dir: string): void {
  const seq = launchModalSeq;

  const branchUrl = dir
    ? `/api/default-branch?projectRoot=${encodeURIComponent(dir)}`
    : "/api/default-branch";
  void authFetch(branchUrl)
    .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(await readApiError(r)))))
    .then((data: { branch?: string }) => {
      if (seq !== launchModalSeq || !launchModalState) return;
      if (data.branch) {
        launchModalState.baseBranchValue = data.branch;
        renderLaunchModalState();
      }
    })
    .catch(() => {});

  const wtUrl = dir
    ? `/api/worktrees?projectRoot=${encodeURIComponent(dir)}`
    : "/api/worktrees";
  void authFetch(wtUrl)
    .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(await readApiError(r)))))
    .then((data: { worktrees?: Array<{ name: string; path: string }> }) => {
      if (seq !== launchModalSeq || !launchModalState) return;
      launchModalState.worktreeOptions = buildWorktreeOptions(dir, data.worktrees);
      if (!launchModalState.worktreeOptions.some((w) => w.value === launchModalState!.selectedWorktree)) {
        launchModalState.selectedWorktree = launchModalState.worktreeOptions[0]?.value ?? "";
      }
      renderLaunchModalState();
    })
    .catch(() => {});
}

function openLaunchModal(groupCwd: string, preselectedWorktree?: string): void {
  const seq = ++launchModalSeq;
  const dirOptions = buildDirectoryOptions();
  // If opening from an active group's +, pre-select that directory; otherwise default to __custom__
  const preselectedDir = groupCwd && dirOptions.some((d) => d.value === groupCwd) ? groupCwd : "__custom__";
  const homeDir = typeof window !== "undefined" ? "" : "";

  launchModalState = {
    selectedAgent: AGENT_CHOICES[0],
    directoryOptions: dirOptions,
    selectedDirectory: preselectedDir,
    customDirectoryValue: preselectedDir === "__custom__" ? (groupCwd || homeDir) : "",
    selectedWorktree: preselectedWorktree ?? "__new__",
    branchValue: "",
    baseBranchValue: "",
    generatedBranch: generateBranchName(),
    launching: false,
    savedFlags: {},
    worktreeOptions: buildWorktreeOptions(groupCwd),
    projectRoot: groupCwd,
  };
  renderLaunchModalState();

  void authFetch("/api/launch-preferences")
    .then((r) => (r.ok ? r.json() : {}))
    .then((prefs: { agent?: string; flags?: Record<string, Record<string, string | boolean>> }) => {
      if (seq !== launchModalSeq || !launchModalState) return;
      if (prefs.flags && typeof prefs.flags === "object") {
        for (const [agent, flags] of Object.entries(prefs.flags)) {
          if (flags && typeof flags === "object") {
            launchModalState.savedFlags[agent] = flags;
          }
        }
      }
      if (prefs.agent && AGENT_CHOICES.includes(prefs.agent)) {
        launchModalState.selectedAgent = prefs.agent;
      }
      renderLaunchModalState();
    })
    .catch(() => {});

  refreshLaunchModalForDirectory(groupCwd);
}

// --- Close worktree modal ---

const closeWorktreeModalRoot = document.createElement("div");
document.body.appendChild(closeWorktreeModalRoot);

type CloseWorktreeModalState = {
  ptyId: string;
  ptyProcess: string;
  worktreeName: string;
  worktreePath: string;
  dirty: boolean | null;
  closing: boolean;
};

let closeWorktreeModalState: CloseWorktreeModalState | null = null;

const NOOP_CLOSE_WORKTREE_HANDLERS = {
  onClose: () => {},
  onCloseSession: () => {},
  onCloseAndRemove: () => {},
};

function renderCloseWorktreeModalState(): void {
  const state = closeWorktreeModalState;
  const model: CloseWorktreeModalViewModel | null = state
    ? {
      ptyProcess: state.ptyProcess,
      worktreeName: state.worktreeName,
      dirty: state.dirty,
      closing: state.closing,
    }
    : null;

  renderCloseWorktreeModal(closeWorktreeModalRoot, model, {
    onClose: () => {
      closeWorktreeModalState = null;
      renderCloseWorktreeModalState();
    },
    onCloseSession: () => {
      if (!closeWorktreeModalState) return;
      const { ptyId } = closeWorktreeModalState;
      closeWorktreeModalState = null;
      renderCloseWorktreeModalState();
      void killPtyDirect(ptyId);
    },
    onCloseAndRemove: () => {
      if (!closeWorktreeModalState || closeWorktreeModalState.closing) return;
      closeWorktreeModalState.closing = true;
      renderCloseWorktreeModalState();
      const { ptyId, worktreePath } = closeWorktreeModalState;
      void (async () => {
        await killPtyDirect(ptyId);
        try {
          await authFetch("/api/worktrees", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: worktreePath }),
          });
        } catch {
          // ignore worktree removal failure
        }
        closeWorktreeModalState = null;
        renderCloseWorktreeModalState();
      })();
    },
  });
}

function openCloseWorktreeModal(ptyId: string): void {
  const p = ptys.find((x) => x.id === ptyId);
  if (!p) return;
  const wt = worktreeName(p.cwd);
  if (!wt || !p.cwd) return;

  const readyInfo = ptyReady.get(p.id) ?? readinessFromSummary(p);
  const activeProcess = compactWhitespace(p.activeProcess ?? "");
  const process =
    (activeProcess && !isShellProcess(activeProcess) ? activeProcess : "") || activeProcess || p.name;

  // Determine the full worktree path from the cwd
  const matchedWt = knownWorktrees.find(
    (w) => p.cwd === w.path || p.cwd!.startsWith(w.path + "/"),
  );
  const worktreePath = matchedWt ? matchedWt.path : p.cwd;

  closeWorktreeModalState = {
    ptyId,
    ptyProcess: process,
    worktreeName: wt,
    worktreePath,
    dirty: null,
    closing: false,
  };
  renderCloseWorktreeModalState();

  // Fetch dirty status
  void authFetch(`/api/worktrees/status?path=${encodeURIComponent(worktreePath)}`)
    .then(async (res) => {
      if (!closeWorktreeModalState || closeWorktreeModalState.ptyId !== ptyId) return;
      if (res.ok) {
        const json = (await res.json()) as { dirty?: boolean };
        closeWorktreeModalState.dirty = json.dirty === true;
      } else {
        closeWorktreeModalState.dirty = false;
      }
      renderCloseWorktreeModalState();
    })
    .catch(() => {
      if (!closeWorktreeModalState || closeWorktreeModalState.ptyId !== ptyId) return;
      closeWorktreeModalState.dirty = false;
      renderCloseWorktreeModalState();
    });
}

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

  inputContextLastEl.classList.remove("clickable");
  inputContextLastEl.onclick = null;

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

async function killPtyDirect(ptyId: string): Promise<void> {
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

function killPty(ptyId: string): void {
  const p = ptys.find((x) => x.id === ptyId);
  if (!p) {
    void killPtyDirect(ptyId);
    return;
  }

  const wt = worktreeName(p.cwd);
  if (!wt) {
    void killPtyDirect(ptyId);
    return;
  }

  // Check if there are other running PTYs in the same worktree
  const sameWorktree = ptys.filter(
    (x) => x.id !== ptyId && x.status === "running" && worktreeName(x.cwd) === wt,
  );
  if (sameWorktree.length > 0) {
    void killPtyDirect(ptyId);
    return;
  }

  // Last PTY in worktree: show the close modal
  openCloseWorktreeModal(ptyId);
}

type RestoreAgentTarget = {
  target?: "same_cwd" | "worktree" | "new_worktree";
  worktreePath?: string;
  branch?: string;
  cwd?: string;
};

async function restoreAgentSession(agentSessionId: string, target?: RestoreAgentTarget): Promise<boolean> {
  const session = agentSessions.find((x) => x.id === agentSessionId);
  if (!session) {
    addEvent(`Failed to restore agent session ${agentSessionId}: unknown session`);
    return false;
  }
  const reqInit: RequestInit = { method: "POST" };
  if (target && Object.keys(target).length > 0) {
    reqInit.headers = { "Content-Type": "application/json" };
    reqInit.body = JSON.stringify(target);
  }
  const res = await authFetch(
    `/api/agent-sessions/${encodeURIComponent(session.provider)}/${encodeURIComponent(session.providerSessionId)}/restore`,
    reqInit,
  );
  if (!res.ok) {
    addEvent(`Failed to restore agent session ${agentSessionId}: ${await readApiError(res)}`);
    return false;
  }
  const json = (await res.json()) as { id: string };
  addEvent(`Restored agent session ${agentSessionId}`);
  await refreshList();
  setActive(json.id);
  return true;
}

function shortSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (trimmed.length <= 14) return trimmed;
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}

function capitalizeWord(s: string): string {
  if (!s) return s;
  return `${s[0].toUpperCase()}${s.slice(1)}`;
}

function lastPathSegment(pathValue: string | null): string {
  if (!pathValue) return "";
  return pathValue.split("/").filter(Boolean).at(-1) ?? "";
}

function displaySessionIntent(session: AgentSessionSummary): string | null {
  const raw = compactWhitespace(session.name);
  if (!raw) return null;
  const projectLeaf = lastPathSegment(session.projectRoot);
  const generic = new Set(
    [
      session.provider,
      `${session.provider}:${projectLeaf}`,
      `${session.provider}:${session.worktree ?? ""}`,
    ].map((v) => v.toLowerCase()),
  );
  return generic.has(raw.toLowerCase()) ? null : raw;
}

function displaySessionCommand(session: AgentSessionSummary): string {
  const args = session.args.filter((arg) => arg && arg !== session.providerSessionId);
  if (args.length > 0 && (args[0] === "resume" || args[0] === "--resume")) {
    return `resume ${shortSessionId(session.providerSessionId)}`;
  }
  if (session.command && args.length > 0) return truncateText(`${session.command} ${args.join(" ")}`, 56);
  if (session.command) return truncateText(session.command, 56);
  return `resume ${shortSessionId(session.providerSessionId)}`;
}

function displaySessionTitle(session: AgentSessionSummary): string {
  const intent = displaySessionIntent(session);
  if (intent) return intent;
  return `${capitalizeWord(session.provider)} session`;
}

function displaySessionSubtitle(session: AgentSessionSummary): string {
  const parts: string[] = [];
  parts.push(displaySessionCommand(session));
  if (session.worktree) {
    parts.push(`branch:${session.worktree}`);
  }
  parts.push(`${session.provider}:${shortSessionId(session.providerSessionId)}`);
  return parts.join(" · ");
}

type RestoreSessionModalState = {
  agentSessionId: string;
  target: RestoreTargetChoice;
  selectedWorktreePath: string;
  customCwdValue: string;
  newBranchValue: string;
  worktreeOptions: Array<{ value: string; label: string }>;
  restoring: boolean;
};

const restoreSessionModalRoot = document.createElement("div");
document.body.appendChild(restoreSessionModalRoot);
let restoreSessionModalState: RestoreSessionModalState | null = null;
let restoreSessionModalSeq = 0;

function closeRestoreSessionModal(): void {
  restoreSessionModalState = null;
  renderRestoreSessionModal(restoreSessionModalRoot, null, {
    onClose: () => {},
    onTargetChange: () => {},
    onWorktreeChange: () => {},
    onCustomCwdChange: () => {},
    onNewBranchChange: () => {},
    onHide: () => {},
    onRestore: () => {},
  });
}

function buildRestoreWorktreeOptions(
  _session: AgentSessionSummary,
  worktrees?: Array<{ name: string; path: string }>,
): Array<{ value: string; label: string }> {
  if (!Array.isArray(worktrees)) return [];
  return worktrees
    .filter((wt) => wt && typeof wt.path === "string" && typeof wt.name === "string")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((wt) => ({ value: wt.path, label: wt.name }));
}

function renderRestoreSessionModalState(): void {
  const state = restoreSessionModalState;
  if (!state) {
    closeRestoreSessionModal();
    return;
  }
  const session = agentSessions.find((x) => x.id === state.agentSessionId);
  if (!session) {
    closeRestoreSessionModal();
    return;
  }
  const model: RestoreSessionModalViewModel = {
    sessionTitle: displaySessionTitle(session),
    sessionSubtitle: displaySessionSubtitle(session),
    provider: session.provider,
    providerSessionId: session.providerSessionId,
    target: state.target,
    sameCwdLabel: session.cwd ? `Use last known location (${session.cwd})` : "Use last known location",
    worktreeOptions: state.worktreeOptions,
    selectedWorktreePath: state.selectedWorktreePath,
    customCwdValue: state.customCwdValue,
    newBranchValue: state.newBranchValue,
    restoring: state.restoring,
  };

  renderRestoreSessionModal(restoreSessionModalRoot, model, {
    onClose: () => {
      closeRestoreSessionModal();
    },
    onTargetChange: (target) => {
      if (!restoreSessionModalState) return;
      restoreSessionModalState.target = target;
      renderRestoreSessionModalState();
    },
    onWorktreeChange: (pathValue) => {
      if (!restoreSessionModalState) return;
      restoreSessionModalState.selectedWorktreePath = pathValue;
      renderRestoreSessionModalState();
    },
    onCustomCwdChange: (cwdValue) => {
      if (!restoreSessionModalState) return;
      restoreSessionModalState.customCwdValue = cwdValue;
      renderRestoreSessionModalState();
    },
    onNewBranchChange: (branchValue) => {
      if (!restoreSessionModalState) return;
      restoreSessionModalState.newBranchValue = branchValue;
      renderRestoreSessionModalState();
    },
    onHide: () => {
      if (!restoreSessionModalState) return;
      hiddenAgentSessionIds.add(restoreSessionModalState.agentSessionId);
      saveHiddenAgentSessions();
      closeRestoreSessionModal();
      renderList();
    },
    onRestore: () => {
      if (!restoreSessionModalState || restoreSessionModalState.restoring) return;
      const stateNow = restoreSessionModalState;
      let target: RestoreAgentTarget = { target: "same_cwd" };
      if (stateNow.target === "worktree") {
        if (!stateNow.selectedWorktreePath) return;
        target = { target: "worktree", worktreePath: stateNow.selectedWorktreePath };
      } else if (stateNow.target === "new_worktree") {
        target = { target: "new_worktree", branch: stateNow.newBranchValue.trim() || `restore-${Date.now()}` };
      } else if (stateNow.target === "custom_cwd") {
        if (!stateNow.customCwdValue.trim()) return;
        target = { target: "same_cwd", cwd: stateNow.customCwdValue.trim() };
      }

      stateNow.restoring = true;
      renderRestoreSessionModalState();
      void restoreAgentSession(stateNow.agentSessionId, target).then((ok) => {
        if (!restoreSessionModalState || restoreSessionModalState.agentSessionId !== stateNow.agentSessionId) return;
        if (ok) {
          closeRestoreSessionModal();
          return;
        }
        restoreSessionModalState.restoring = false;
        renderRestoreSessionModalState();
      });
    },
  });
}

function openAgentSessionActions(agentSessionId: string): void {
  const session = agentSessions.find((x) => x.id === agentSessionId);
  if (!session) return;
  const seq = ++restoreSessionModalSeq;
  const matchedWt = session.worktree
    ? knownWorktrees.find((w) => (w.branch || w.name) === session.worktree)
    : null;
  const suggestedWorktreePath = matchedWt ? matchedWt.path : "";
  const suggestedBranch = session.worktree ?? `restore-${Date.now()}`;
  const defaultTarget: RestoreTargetChoice = suggestedWorktreePath ? "worktree" : "same_cwd";
  restoreSessionModalState = {
    agentSessionId,
    target: defaultTarget,
    selectedWorktreePath: suggestedWorktreePath,
    customCwdValue: session.cwd ?? session.projectRoot ?? "",
    newBranchValue: suggestedBranch,
    worktreeOptions: [],
    restoring: false,
  };
  renderRestoreSessionModalState();

  void authFetch("/api/worktrees")
    .then(async (res) => (res.ok ? res.json() : Promise.reject(new Error(await readApiError(res)))))
    .then((data: { worktrees?: Array<{ name: string; path: string }> }) => {
      if (!restoreSessionModalState || seq !== restoreSessionModalSeq) return;
      const state = restoreSessionModalState;
      state.worktreeOptions = buildRestoreWorktreeOptions(session, data.worktrees);
      if (
        state.worktreeOptions.length > 0 &&
        !state.worktreeOptions.some((wt) => wt.value === state.selectedWorktreePath)
      ) {
        state.selectedWorktreePath = state.worktreeOptions[0].value;
      }
      if (state.target === "worktree" && state.worktreeOptions.length === 0) {
        state.target = "same_cwd";
      }
      renderRestoreSessionModalState();
    })
    .catch(() => {
      if (!restoreSessionModalState || seq !== restoreSessionModalSeq) return;
      restoreSessionModalState.worktreeOptions = [];
      if (restoreSessionModalState.target === "worktree") restoreSessionModalState.target = "same_cwd";
      renderRestoreSessionModalState();
    });
}

function normalizeCwdGroupKey(cwd: string): string {
  // If cwd matches a known worktree path, group under the main repo root
  for (const wt of knownWorktrees) {
    if (cwd === wt.path || cwd.startsWith(wt.path + "/")) {
      return serverRepoRoot || cwd;
    }
  }
  // Fallback: also handle legacy .worktrees/ paths for backwards compat
  const idx = cwd.indexOf("/.worktrees/");
  if (idx !== -1) return cwd.slice(0, idx);
  return cwd;
}

function worktreeName(cwd: string | null): string | null {
  if (!cwd) return null;
  for (const wt of knownWorktrees) {
    if (cwd === wt.path || cwd.startsWith(wt.path + "/")) {
      return wt.branch || wt.name;
    }
  }
  // Fallback: legacy .worktrees/ pattern
  const m = cwd.match(/\/\.worktrees\/([^/]+)/);
  return m ? m[1] : null;
}

const collapsedGroups = new Set<string>();
const collapsedWorktrees = new Set<string>(); // "groupKey::worktreeName"
const inlineInactiveExpanded = new Set<string>(); // directory keys where inline recent is expanded
const collapsedAgentSessionGroups = new Set<string>();
const collapsedAgentSessionWorktrees = new Set<string>(); // "projectKey::worktreeName"
const AGENT_GROUPS_COLLAPSED_KEY = "agmux:agentSessionGroupsCollapsed";
const AGENT_WORKTREES_COLLAPSED_KEY = "agmux:agentSessionWorktreesCollapsed";

const AUTO_COLLAPSE_PROJECT_THRESHOLD = 4;
const AUTO_COLLAPSE_PROJECT_SIZE = 5;
const AUTO_COLLAPSE_WORKTREE_THRESHOLD = 3;
const AUTO_COLLAPSE_WORKTREE_SIZE = 4;
const AUTO_COLLAPSE_SECTION_TOTAL = 8;

function loadCollapsedSet(key: string, target: Set<string>): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return true;
    for (const value of parsed) {
      if (typeof value === "string") target.add(value);
    }
    return true;
  } catch {
    // ignore
    return false;
  }
}

function saveCollapsedSet(key: string, source: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...source]));
  } catch {
    // ignore
  }
}

function loadBooleanPreference(key: string): boolean | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  } catch {
    return null;
  }
}

function saveBooleanPreference(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // ignore
  }
}

let hasStoredAgentGroupCollapsePref = loadCollapsedSet(AGENT_GROUPS_COLLAPSED_KEY, collapsedAgentSessionGroups);
let hasStoredAgentWorktreeCollapsePref = loadCollapsedSet(AGENT_WORKTREES_COLLAPSED_KEY, collapsedAgentSessionWorktrees);
let inactiveSessionsExpanded = false;
const ARCHIVED_SECTION_EXPANDED_KEY = "agmux:archivedSectionExpanded";
const ARCHIVED_GROUPS_COLLAPSED_KEY = "agmux:archivedGroupsCollapsed";
const ARCHIVED_WORKTREES_COLLAPSED_KEY = "agmux:archivedWorktreesCollapsed";
const collapsedArchivedGroups = new Set<string>();
const collapsedArchivedWorktrees = new Set<string>();
loadCollapsedSet(ARCHIVED_GROUPS_COLLAPSED_KEY, collapsedArchivedGroups);
loadCollapsedSet(ARCHIVED_WORKTREES_COLLAPSED_KEY, collapsedArchivedWorktrees);
let archivedSectionExpandedOverride = loadBooleanPreference(ARCHIVED_SECTION_EXPANDED_KEY);

function buildRunningPtyItem(p: PtySummary): RunningPtyItem {
  const title = (ptyTitles.get(p.id) ?? "").trim();
  const activeProcess = compactWhitespace(p.activeProcess ?? "");
  const process =
    (activeProcess && !isShellProcess(activeProcess) ? activeProcess : "") || activeProcess || title || p.name;
  const inputPreview = ptyLastInput.get(p.id) ?? "";
  const readyInfo = ptyReady.get(p.id) ?? readinessFromSummary(p);
  const changedAt = ptyStateChangedAt.get(p.id);
  const elapsed = changedAt ? formatElapsedTime(changedAt) : "";
  const secondaryText = title && title !== process ? title : inputPreview ? `> ${inputPreview}` : p.name;

  return {
    id: p.id,
    color: ptyColor(p.id),
    active: p.id === activePtyId,
    readyState: readyInfo.state,
    readyIndicator: readyInfo.indicator,
    readyReason: readyInfo.reason,
    process,
    title: title && title !== process ? title : undefined,
    secondaryText,
    worktree: worktreeName(p.cwd),
    cwd: p.cwd ?? undefined,
    elapsed: elapsed || undefined,
  };
}

function buildInactiveAgentSessionItem(session: AgentSessionSummary): InactivePtyItem {
  const process = displaySessionTitle(session);
  const intent = displaySessionIntent(session);
  const elapsed = formatElapsedTime(session.lastSeenAt);
  const worktree = session.worktree ?? worktreeName(session.cwd);

  const tooltipParts = [capitalizeWord(session.provider)];
  if (intent) tooltipParts.push(intent);
  if (elapsed) tooltipParts.push(`${elapsed} ago`);
  if (worktree) tooltipParts.push(`worktree: ${worktree}`);

  return {
    id: session.id,
    color: ptyColor(session.id),
    process,
    secondaryText: "",
    secondaryTitle: tooltipParts.join("\n"),
    worktree,
    cwd: session.cwd ?? undefined,
    elapsed: elapsed || undefined,
    exitLabel: `${session.provider} session`,
  };
}

function buildInactiveWorktreeSubgroups(
  items: InactivePtyItem[],
  keyPrefix: string,
): { rootItems: InactivePtyItem[]; worktrees: InactiveWorktreeSubgroup[] } {
  const rootItems: InactivePtyItem[] = [];
  const wtMap = new Map<string, { items: InactivePtyItem[]; path: string }>();
  for (const item of items) {
    if (item.worktree) {
      let wt = wtMap.get(item.worktree);
      if (!wt) {
        wt = { items: [], path: item.cwd ?? "" };
        wtMap.set(item.worktree, wt);
      }
      wt.items.push(item);
    } else {
      rootItems.push(item);
    }
  }
  const worktrees = [...wtMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, wt]) => {
      const wtKey = `${keyPrefix}::${name}`;
      const worktreeCount = wtMap.size;
      const autoCollapseWorktree = !hasStoredAgentWorktreeCollapsePref &&
        (worktreeCount >= AUTO_COLLAPSE_WORKTREE_THRESHOLD || wt.items.length >= AUTO_COLLAPSE_WORKTREE_SIZE);
      return {
        name,
        path: wt.path,
        collapsed: collapsedAgentSessionWorktrees.has(wtKey) || autoCollapseWorktree,
        items: wt.items,
      };
    });
  return { rootItems, worktrees };
}

function renderList(): void {
  // Group running PTYs by CWD (normalize .worktrees/ paths to parent repo).
  const runningPtys = ptys.filter((p) => p.status === "running");
  const runningByDir = new Map<string, RunningPtyItem[]>();
  for (const p of runningPtys) {
    const key = p.cwd ? normalizeCwdGroupKey(p.cwd) : "";
    let arr = runningByDir.get(key);
    if (!arr) {
      arr = [];
      runningByDir.set(key, arr);
    }
    arr.push(buildRunningPtyItem(p));
  }

  // Group inactive agent sessions by projectRoot.
  const sortedAgentSessions = [...agentSessions]
    .filter((s) => !hiddenAgentSessionIds.has(s.id))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const inactiveByProject = new Map<string, InactivePtyItem[]>();
  for (const session of sortedAgentSessions) {
    const key = session.projectRoot ?? "";
    const item = buildInactiveAgentSessionItem(session);
    const items = inactiveByProject.get(key) ?? [];
    items.push(item);
    inactiveByProject.set(key, items);
  }

  // Auto-unarchive directories that have running sessions
  for (const k of runningByDir.keys()) {
    if (archivedDirectories.has(k)) {
      archivedDirectories.delete(k);
      saveArchivedDirectories();
    }
  }

  // Collect all visible directory keys: pinned dirs + dirs with running PTYs (exclude archived).
  const visibleDirKeys = new Set<string>(
    [...pinnedDirectories, ...runningByDir.keys()].filter((k) => !archivedDirectories.has(k)),
  );

  // Helper to sort directory keys: non-empty alphabetically by basename, empty last.
  const sortByBasename = (a: string, b: string) => {
    if (!a) return 1;
    if (!b) return -1;
    const ba = a.split("/").filter(Boolean).at(-1) ?? a;
    const bb = b.split("/").filter(Boolean).at(-1) ?? b;
    return ba.localeCompare(bb);
  };

  // Build unified directory groups: pinned first, then non-pinned, both alphabetical.
  const pinnedKeys = [...visibleDirKeys].filter((k) => pinnedDirectories.has(k)).sort(sortByBasename);
  const nonPinnedKeys = [...visibleDirKeys].filter((k) => !pinnedDirectories.has(k)).sort(sortByBasename);
  const allVisibleKeys = [...pinnedKeys, ...nonPinnedKeys];

  const groups: PtyGroup[] = allVisibleKeys.map((key) => {
    const basename = key ? key.split("/").filter(Boolean).at(-1) ?? key : "Other";
    const runningItems = runningByDir.get(key) ?? [];

    // Sub-group running items by worktree
    const rootItems: RunningPtyItem[] = [];
    const wtMap = new Map<string, { items: RunningPtyItem[]; path: string }>();
    for (const item of runningItems) {
      if (item.worktree) {
        let wt = wtMap.get(item.worktree);
        if (!wt) {
          wt = { items: [], path: item.cwd ?? "" };
          wtMap.set(item.worktree, wt);
        }
        wt.items.push(item);
      } else {
        rootItems.push(item);
      }
    }

    const worktrees: WorktreeSubgroup[] = [...wtMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, wt]) => ({
        name,
        path: wt.path,
        collapsed: collapsedWorktrees.has(`${key}::${name}`),
        items: wt.items,
      }));

    // Inline inactive sessions for this directory
    const dirInactiveItems = inactiveByProject.get(key) ?? [];
    const inactiveSub = buildInactiveWorktreeSubgroups(dirInactiveItems, key);

    return {
      key,
      label: basename,
      title: key || undefined,
      pinned: pinnedDirectories.has(key),
      collapsed: collapsedGroups.has(key),
      worktrees,
      items: rootItems,
      inactiveSessions: inactiveSub.rootItems,
      inactiveWorktrees: inactiveSub.worktrees,
      inactiveTotal: dirInactiveItems.length,
      inlineInactiveExpanded: inlineInactiveExpanded.has(key),
    };
  });

  // Build "Inactive" section: directories with sessions that are not pinned, not running, and not archived.
  // Directories confirmed to not exist on disk are treated as archived.
  const orphanInactiveKeys: string[] = [];
  const autoArchivedKeys: string[] = [];
  for (const k of [...inactiveByProject.keys()].sort(sortByBasename)) {
    if (visibleDirKeys.has(k) || archivedDirectories.has(k)) continue;
    const exists = directoryExistsCache.get(k);
    if (exists === false) {
      autoArchivedKeys.push(k);
    } else {
      orphanInactiveKeys.push(k);
    }
  }

  const orphanGroups = orphanInactiveKeys.map((key) => {
    const allItems = inactiveByProject.get(key) ?? [];
    const sub = buildInactiveWorktreeSubgroups(allItems, key);
    const groupTotal = allItems.length;
    const autoCollapseGroup = !hasStoredAgentGroupCollapsePref &&
      (orphanInactiveKeys.length >= AUTO_COLLAPSE_PROJECT_THRESHOLD || groupTotal >= AUTO_COLLAPSE_PROJECT_SIZE);
    return {
      key,
      label: key ? key.split("/").filter(Boolean).at(-1) ?? key : "(unknown project)",
      title: key || undefined,
      collapsed: collapsedAgentSessionGroups.has(key) || autoCollapseGroup,
      total: groupTotal,
      items: sub.rootItems,
      worktrees: sub.worktrees,
    };
  });

  const orphanTotal = orphanGroups.reduce((acc, g) => acc + g.total, 0);

  // Build "Archived" section: explicitly archived directories + dirs that no longer exist on disk.
  const archivedKeys = [
    ...[...archivedDirectories].filter((k) => inactiveByProject.has(k)),
    ...autoArchivedKeys,
  ].sort(sortByBasename);

  const archivedGroups = archivedKeys.map((key) => {
    const allItems = inactiveByProject.get(key) ?? [];
    const sub = buildInactiveWorktreeSubgroups(allItems, key);
    const groupTotal = allItems.length;
    return {
      key,
      label: key ? key.split("/").filter(Boolean).at(-1) ?? key : "(unknown project)",
      title: key || undefined,
      collapsed: collapsedArchivedGroups.has(key),
      total: groupTotal,
      items: sub.rootItems,
      worktrees: sub.worktrees,
      archived: true as const,
    };
  });

  const archivedTotal = archivedGroups.reduce((acc, g) => acc + g.total, 0);
  const archivedAutoExpanded = !(
    archivedTotal >= AUTO_COLLAPSE_SECTION_TOTAL ||
    archivedGroups.length >= AUTO_COLLAPSE_PROJECT_THRESHOLD
  );
  const archivedExpanded = archivedSectionExpandedOverride ?? archivedAutoExpanded;

  const model: PtyListModel = {
    groups,
    showHeaders: allVisibleKeys.length >= 1,
    inactive: orphanTotal > 0
      ? {
        label: "Inactive",
        expanded: inactiveSessionsExpanded,
        total: orphanTotal,
        groups: orphanGroups,
      }
      : null,
    archived: archivedTotal > 0
      ? {
        label: "Archived",
        expanded: archivedExpanded,
        total: archivedTotal,
        groups: archivedGroups,
      }
      : null,
  };

  renderPtyList(listEl, model, {
    onToggleGroup: (groupKey) => {
      if (collapsedGroups.has(groupKey)) collapsedGroups.delete(groupKey);
      else collapsedGroups.add(groupKey);
      renderList();
    },
    onToggleWorktree: (groupKey, wtName) => {
      const key = `${groupKey}::${wtName}`;
      if (collapsedWorktrees.has(key)) collapsedWorktrees.delete(key);
      else collapsedWorktrees.add(key);
      renderList();
    },
    onTogglePin: (groupKey) => {
      if (pinnedDirectories.has(groupKey)) pinnedDirectories.delete(groupKey);
      else pinnedDirectories.add(groupKey);
      savePinnedDirectories();
      renderList();
    },
    onToggleInlineInactive: (groupKey) => {
      if (inlineInactiveExpanded.has(groupKey)) inlineInactiveExpanded.delete(groupKey);
      else inlineInactiveExpanded.add(groupKey);
      renderList();
    },
    onOpenLaunch: (groupKey) => openLaunchModal(groupKey),
    onOpenLaunchInWorktree: (groupKey, worktreePath) => openLaunchModal(groupKey, worktreePath),
    onSelectPty: (ptyId) => setActive(ptyId),
    onKillPty: (ptyId) => {
      killPty(ptyId);
    },
    onResumeInactive: (ptyId) => {
      openAgentSessionActions(ptyId);
    },
    onInactiveActions: (ptyId) => {
      openAgentSessionActions(ptyId);
    },
    onToggleInactive: () => {
      inactiveSessionsExpanded = !inactiveSessionsExpanded;
      renderList();
    },
    onToggleInactiveGroup: (groupKey) => {
      if (collapsedAgentSessionGroups.has(groupKey)) collapsedAgentSessionGroups.delete(groupKey);
      else collapsedAgentSessionGroups.add(groupKey);
      hasStoredAgentGroupCollapsePref = true;
      saveCollapsedSet(AGENT_GROUPS_COLLAPSED_KEY, collapsedAgentSessionGroups);
      renderList();
    },
    onToggleInactiveWorktree: (groupKey, wtName) => {
      const key = `${groupKey}::${wtName}`;
      if (collapsedAgentSessionWorktrees.has(key)) collapsedAgentSessionWorktrees.delete(key);
      else collapsedAgentSessionWorktrees.add(key);
      hasStoredAgentWorktreeCollapsePref = true;
      saveCollapsedSet(AGENT_WORKTREES_COLLAPSED_KEY, collapsedAgentSessionWorktrees);
      renderList();
    },
    onArchive: (groupKey) => archiveDirectory(groupKey),
    onUnarchive: (groupKey) => unarchiveDirectory(groupKey),
    onToggleArchived: () => {
      archivedSectionExpandedOverride = !archivedExpanded;
      saveBooleanPreference(ARCHIVED_SECTION_EXPANDED_KEY, archivedSectionExpandedOverride);
      renderList();
    },
    onToggleArchivedGroup: (groupKey) => {
      if (collapsedArchivedGroups.has(groupKey)) collapsedArchivedGroups.delete(groupKey);
      else collapsedArchivedGroups.add(groupKey);
      saveCollapsedSet(ARCHIVED_GROUPS_COLLAPSED_KEY, collapsedArchivedGroups);
      renderList();
    },
    onToggleArchivedWorktree: (groupKey, wtName) => {
      const key = `${groupKey}::${wtName}`;
      if (collapsedArchivedWorktrees.has(key)) collapsedArchivedWorktrees.delete(key);
      else collapsedArchivedWorktrees.add(key);
      saveCollapsedSet(ARCHIVED_WORKTREES_COLLAPSED_KEY, collapsedArchivedWorktrees);
      renderList();
    },
    onShowMore: (_contextKey) => {
      // Pagination state is managed in pty-list-view; just re-render.
      renderList();
    },
  });
}

function focusActiveTerm(): void {
  const st = activePtyId ? terms.get(activePtyId) : null;
  if (st) st.term.focus();
}

function setActive(ptyId: string): void {
  const summary = ptys.find((p) => p.id === ptyId);
  if (!summary || summary.status !== "running") {
    pendingActivePtyId = ptyId;
    return;
  }
  pendingActivePtyId = null;

  activePtyId = ptyId;
  saveActivePty(ptyId);
  ensureTerm(ptyId);
  updateTerminalVisibility();
  subscribeIfNeeded(ptyId);
  requestAnimationFrame(() => {
    fitAndResizeActive();
    reflowActiveTerm();
    focusActiveTerm();
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
    (p) =>
      p.status === "running" &&
      p.backend === "tmux" &&
      (p.tmuxSession ?? "") === selected.name &&
      (p.tmuxServer ?? "agmux") === selected.server,
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

// Debounced reflow: coalesces multiple writes within a single frame into one
// reflow.  Called after pty_output writes so that snapshots arriving after
// reconnect (which land after the initial setActive reflow) still get reflowed.
let reflowRafPending = false;
function scheduleReflow(): void {
  if (reflowRafPending) return;
  reflowRafPending = true;
  requestAnimationFrame(() => {
    reflowRafPending = false;
    reflowActiveTerm();
  });
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
        if (activePtyId) killPty(activePtyId);
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

// --- Settings modal ---

const DEFAULT_WORKTREE_TEMPLATE = "../{repo-name}-{branch}";

const settingsModalRoot = document.createElement("div");
document.body.appendChild(settingsModalRoot);

type SettingsModalState = {
  worktreePathTemplate: string;
  saving: boolean;
};

let settingsModalState: SettingsModalState | null = null;

function settingsPreviewPath(template: string): string {
  const t = template || DEFAULT_WORKTREE_TEMPLATE;
  const repoName = serverRepoRoot ? serverRepoRoot.split("/").pop() ?? "repo" : "repo";
  return t
    .replace(/\{repo-name\}/g, repoName)
    .replace(/\{repo-root\}/g, serverRepoRoot || "/path/to/repo")
    .replace(/\{branch\}/g, "feature-example");
}

function renderSettingsModalState(): void {
  const state = settingsModalState;
  const themeOptions = [...THEMES].map(([key, theme]) => ({ key, name: theme.name }));
  const model: SettingsModalViewModel | null = state
    ? {
      worktreePathTemplate: state.worktreePathTemplate,
      previewPath: settingsPreviewPath(state.worktreePathTemplate),
      saving: state.saving,
      themeKey: activeThemeKey,
      themes: themeOptions,
    }
    : null;

  renderSettingsModal(settingsModalRoot, model, {
    onClose: () => {
      settingsModalState = null;
      renderSettingsModalState();
    },
    onTemplateChange: (value) => {
      if (!settingsModalState) return;
      settingsModalState.worktreePathTemplate = value;
      renderSettingsModalState();
    },
    onReset: () => {
      if (!settingsModalState) return;
      settingsModalState.worktreePathTemplate = "";
      renderSettingsModalState();
    },
    onThemeChange: (key) => {
      setTheme(key);
      renderSettingsModalState();
    },
    onSave: () => {
      if (!settingsModalState || settingsModalState.saving) return;
      settingsModalState.saving = true;
      renderSettingsModalState();
      const template = settingsModalState.worktreePathTemplate.trim() || null;
      void authFetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worktreePathTemplate: template }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(await readApiError(res));
          settingsModalState = null;
          renderSettingsModalState();
        })
        .catch((err) => {
          if (!settingsModalState) return;
          settingsModalState.saving = false;
          renderSettingsModalState();
          window.alert(errorMessage(err));
        });
    },
  });
}

function openSettingsModal(): void {
  settingsModalState = {
    worktreePathTemplate: "",
    saving: false,
  };
  renderSettingsModalState();

  void authFetch("/api/settings")
    .then(async (res) => {
      if (!res.ok || !settingsModalState) return;
      const data = (await res.json()) as { worktreePathTemplate?: string };
      settingsModalState.worktreePathTemplate = data.worktreePathTemplate ?? "";
      renderSettingsModalState();
    })
    .catch(() => {});
}

const btnSettings = $("btn-settings") as HTMLButtonElement;
btnSettings.addEventListener("click", () => openSettingsModal());

void (async () => {
  try {
    await ensureAuthToken();
    await Promise.all([loadPtyInputMeta(), refreshWorktreeCache()]);
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
          ? running.find(
            (p) =>
              p.backend === "tmux" &&
              p.tmuxSession === saved.tmuxSession &&
              (saved.tmuxServer ? p.tmuxServer === saved.tmuxServer : true),
          )
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

(window as any).__agmux = {
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
