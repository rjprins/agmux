import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";

type PtySummary = {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string | null;
  createdAt: number;
  status: "running" | "exited";
  exitCode?: number | null;
  exitSignal?: string | null;
};

type ServerMsg =
  | { type: "pty_list"; ptys: PtySummary[] }
  | { type: "pty_output"; ptyId: string; data: string }
  | { type: "pty_exit"; ptyId: string; code: number | null; signal: string | null }
  | { type: "trigger_fired"; ptyId: string; trigger: string; match: string; line: string; ts: number }
  | { type: "pty_highlight"; ptyId: string; reason: string; ttlMs: number }
  | { type: "trigger_error"; ptyId: string; trigger: string; ts: number; message: string };

const $ = (id: string) => document.getElementById(id)!;

const listEl = $("pty-list");
const terminalEl = $("terminal");
const eventsEl = $("events");

let ptys: PtySummary[] = [];
let activePtyId: string | null = null;
const ptyTitles = new Map<string, string>();

const btnNew = $("btn-new") as HTMLButtonElement;

type TermState = {
  ptyId: string;
  container: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  lastResize: { cols: number; rows: number } | null;
};

const terms = new Map<string, TermState>();
const subscribed = new Set<string>();

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

function createTermState(ptyId: string): TermState {
  const container = document.createElement("div");
  container.className = "term-pane hidden";
  container.dataset.ptyId = ptyId;
  terminalEl.appendChild(container);

  const term = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontSize: 13,
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    theme: {
      background: "#0b0e14",
      foreground: "#e7ecff",
      cursor: "#ffcc66",
      selectionBackground: "rgba(255, 204, 102, 0.25)",
    },
    scrollback: 5000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);

  term.onData((data) => {
    if (activePtyId !== ptyId) return;
    ws.send(JSON.stringify({ type: "input", ptyId, data }));
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
}

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

const ws = new WebSocket(wsUrl());

ws.addEventListener("open", () => {
  addEvent(`WS connected`);
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
      }
    }

    // Drop terminals for sessions that are no longer running.
    const running = new Set(ptys.filter((p) => p.status === "running").map((p) => p.id));
    for (const ptyId of terms.keys()) {
      if (!running.has(ptyId)) removeTerm(ptyId);
    }

    updateTerminalVisibility();
    renderList();
    return;
  }
  if (msg.type === "pty_output") {
    const st = ensureTerm(msg.ptyId);
    st.term.write(msg.data);
    return;
  }
  if (msg.type === "pty_exit") {
    addEvent(`PTY exited: ${msg.ptyId} code=${msg.code ?? "?"} signal=${msg.signal ?? "-"}`);
    refreshList();
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

function addEvent(text: string): void {
  const el = document.createElement("div");
  el.className = "event";
  el.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  eventsEl.prepend(el);
  while (eventsEl.children.length > 50) eventsEl.removeChild(eventsEl.lastElementChild!);
}

async function refreshList(): Promise<void> {
  const res = await fetch("/api/ptys");
  const json = (await res.json()) as { ptys: PtySummary[] };
  ptys = json.ptys;
  updateTerminalVisibility();
  renderList();
}

function hashHue(s: string): number {
  // Deterministic, cheap hash -> hue in [0, 359].
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function ptyColor(ptyId: string): string {
  return `hsl(${hashHue(ptyId)} 85% 62%)`;
}

function shortId(ptyId: string): string {
  if (ptyId.length <= 14) return ptyId;
  return `${ptyId.slice(0, 6)}...${ptyId.slice(-6)}`;
}

async function killPty(ptyId: string): Promise<void> {
  await fetch(`/api/ptys/${encodeURIComponent(ptyId)}/kill`, { method: "POST" });
  addEvent(`Killed PTY ${ptyId}`);

  if (activePtyId === ptyId) {
    activePtyId = null;
  }
  removeTerm(ptyId);
  updateTerminalVisibility();

  await refreshList();
}

function renderList(): void {
  listEl.textContent = "";
  for (const p of ptys) {
    if (p.status !== "running") continue; // Don't show killed/exited PTYs.

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
    const primary = document.createElement("div");
    primary.className = "primary";
    primary.textContent = title || p.name;

    const secondary = document.createElement("div");
    secondary.className = "secondary";
    secondary.textContent = title ? p.name : shortId(p.id);

    main.appendChild(primary);
    main.appendChild(secondary);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "pty-close";
    closeBtn.textContent = "x";
    closeBtn.title = "Close";
    closeBtn.setAttribute("aria-label", `Close PTY ${p.name}`);
    closeBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await killPty(p.id);
    });

    row.appendChild(main);
    row.appendChild(closeBtn);

    li.appendChild(row);

    li.addEventListener("click", () => setActive(p.id));
    listEl.appendChild(li);
  }
}

function setActive(ptyId: string): void {
  activePtyId = ptyId;
  ensureTerm(ptyId);
  updateTerminalVisibility();
  subscribeIfNeeded(ptyId);
  requestAnimationFrame(() => {
    fitAndResizeActive();
    const st = terms.get(ptyId);
    if (st) {
      st.term.refresh(0, Math.max(0, st.term.rows - 1));
      st.term.focus();
    }
  });
  renderList();
}

function highlight(ptyId: string, ttlMs: number): void {
  const el = listEl.querySelector(`[data-pty-id="${ptyId}"]`) as HTMLElement | null;
  if (!el) return;
  el.classList.add("highlight");
  setTimeout(() => el.classList.remove("highlight"), ttlMs);
}

async function newShell(): Promise<void> {
  const res = await fetch("/api/ptys/shell", { method: "POST" });
  if (!res.ok) {
    addEvent(`Failed to create PTY (${res.status})`);
    return;
  }
  const json = (await res.json()) as { id: string };
  addEvent(`Created PTY ${json.id}`);
  await refreshList();
  setActive(json.id);
}

btnNew.addEventListener("click", () => {
  newShell().catch(() => {
    // ignore
  });
});

$("btn-reload-triggers").addEventListener("click", async () => {
  await fetch("/api/triggers/reload", { method: "POST" });
  addEvent("Requested trigger reload");
});

function subscribeIfNeeded(ptyId: string): void {
  if (subscribed.has(ptyId)) return;
  subscribed.add(ptyId);
  ws.send(JSON.stringify({ type: "subscribe", ptyId }));
}

function updateTerminalVisibility(): void {
  const hasActive = Boolean(activePtyId);
  placeholderEl.classList.toggle("hidden", hasActive);
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
  ws.send(JSON.stringify({ type: "resize", ptyId: activePtyId, cols, rows }));
}

const ro = new ResizeObserver(() => {
  requestAnimationFrame(() => fitAndResizeActive());
});
ro.observe(terminalEl);
window.addEventListener("resize", () => fitAndResizeActive());

refreshList().catch(() => {
  // ignore
});

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
};
