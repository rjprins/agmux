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
const inputEl = $("input") as HTMLInputElement;
const activeTitleEl = $("active-title");
const eventsEl = $("events");
const btnKill = $("btn-kill") as HTMLButtonElement;

let ptys: PtySummary[] = [];
let activePtyId: string | null = null;

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
  const supUrl = `${location.protocol}//127.0.0.1:4822/events`;
  const es = new EventSource(supUrl);
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
    renderList();
    return;
  }
  if (msg.type === "pty_output") {
    if (msg.ptyId === activePtyId) {
      terminalEl.textContent += msg.data;
      terminalEl.scrollTop = terminalEl.scrollHeight;
    }
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
  renderList();
}

function renderList(): void {
  listEl.textContent = "";
  for (const p of ptys) {
    const li = document.createElement("li");
    li.className = "pty-item";
    li.dataset.ptyId = p.id;
    if (p.id === activePtyId) li.classList.add("active");

    const row = document.createElement("div");
    row.className = "row";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = p.name;

    const badge = document.createElement("div");
    badge.className = `badge ${p.status}`;
    badge.textContent = p.status;

    row.appendChild(name);
    row.appendChild(badge);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${p.command} ${p.args.join(" ")}${p.cwd ? `  (cwd: ${p.cwd})` : ""}`;

    li.appendChild(row);
    li.appendChild(meta);

    li.addEventListener("click", () => setActive(p.id));
    listEl.appendChild(li);
  }
  btnKill.disabled = !activePtyId;
}

function setActive(ptyId: string): void {
  activePtyId = ptyId;
  terminalEl.textContent = "";
  const p = ptys.find((x) => x.id === ptyId);
  activeTitleEl.textContent = p ? `${p.name} (${p.id})` : ptyId;
  btnKill.disabled = false;
  inputEl.disabled = false;

  ws.send(JSON.stringify({ type: "subscribe", ptyId }));
  renderList();
}

function highlight(ptyId: string, ttlMs: number): void {
  const el = listEl.querySelector(`[data-pty-id="${ptyId}"]`) as HTMLElement | null;
  if (!el) return;
  el.classList.add("highlight");
  setTimeout(() => el.classList.remove("highlight"), ttlMs);
}

$("btn-new").addEventListener("click", async () => {
  const command = prompt("Command to run", "bash");
  if (!command) return;
  const name = prompt("Name (optional)", command) ?? command;
  const argsRaw = prompt('Args as JSON array (e.g. ["-lc","echo hi"] )', "[]") ?? "[]";
  let args: string[] = [];
  try {
    const parsed = JSON.parse(argsRaw);
    if (Array.isArray(parsed)) args = parsed.map(String);
  } catch {
    addEvent("Invalid args JSON; using []");
  }
  const cwd = prompt("CWD (optional)", "") ?? "";

  const res = await fetch("/api/ptys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      command,
      args,
      cwd: cwd.trim().length ? cwd.trim() : undefined,
      cols: 120,
      rows: 30,
    }),
  });
  if (!res.ok) {
    addEvent(`Failed to create PTY (${res.status})`);
    return;
  }
  const json = (await res.json()) as { id: string };
  addEvent(`Created PTY ${json.id}`);
  await refreshList();
  setActive(json.id);
});

$("btn-reload-triggers").addEventListener("click", async () => {
  await fetch("/api/triggers/reload", { method: "POST" });
  addEvent("Requested trigger reload");
});

btnKill.addEventListener("click", async () => {
  if (!activePtyId) return;
  await fetch(`/api/ptys/${encodeURIComponent(activePtyId)}/kill`, { method: "POST" });
  addEvent(`Killed PTY ${activePtyId}`);
});

inputEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  if (!activePtyId) return;
  const v = inputEl.value;
  inputEl.value = "";
  ws.send(JSON.stringify({ type: "input", ptyId: activePtyId, data: v + "\n" }));
});

refreshList().catch(() => {
  // ignore
});
