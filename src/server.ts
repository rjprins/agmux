import Fastify from "fastify";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import { PtyManager } from "./pty/manager.js";
import { SqliteStore } from "./persist/sqlite.js";
import type { ClientToServerMessage, PtySummary, ServerToClientMessage } from "./types.js";
import { WsHub } from "./ws/hub.js";
import { TriggerEngine } from "./triggers/engine.js";
import { TriggerLoader } from "./triggers/loader.js";
import {
  tmuxAttachArgs,
  tmuxKillSession,
  tmuxLocateSession,
  tmuxNewSessionDetached,
} from "./tmux.js";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 4821);
const PUBLIC_DIR = path.resolve("public");
const DB_PATH = process.env.DB_PATH ?? path.resolve("data/agent-tide.db");
const TRIGGERS_PATH = process.env.TRIGGERS_PATH ?? path.resolve("triggers/index.js");

const fastify = Fastify({ logger: true });

const store = new SqliteStore(DB_PATH);
const ptys = new PtyManager();
const hub = new WsHub();
const triggerEngine = new TriggerEngine();
const triggerLoader = new TriggerLoader(TRIGGERS_PATH);

function mergePtys(live: PtySummary[], persisted: PtySummary[]): PtySummary[] {
  const byId = new Map<string, PtySummary>();
  for (const p of persisted) byId.set(p.id, p);
  for (const p of live) byId.set(p.id, p);
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
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
    hub.broadcast({
      type: "trigger_error",
      ptyId: "system",
      trigger: "reload",
      ts: Date.now(),
      message,
    } as any);
  }
}

// PTY events -> persistence + triggers + WS
ptys.on("output", (ptyId: string, data: string) => {
  const summary = ptys.getSummary(ptyId);
  const out = summary?.backend === "tmux" ? stripAlternateScreenSequences(data) : data;
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
  broadcast({ type: "pty_exit", ptyId, code, signal });

  // If this PTY is an attachment to a persistent tmux session, try to reattach.
  // This keeps "agent is alive" semantics separate from an individual server-side PTY attachment.
  if (summary?.backend === "tmux" && summary.tmuxSession) {
    void (async () => {
      const server = await tmuxLocateSession(summary.tmuxSession!);
      if (!server) return;
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
      broadcast({ type: "pty_list", ptys: mergePtys(ptys.list(), store.listSessions()) });
    })();
  }
});

// REST API
fastify.get("/api/ptys", async () => {
  const live = ptys.list();
  const persisted = store.listSessions();
  return { ptys: mergePtys(live, persisted) };
});

fastify.post("/api/ptys", async (req, reply) => {
  const body = (req.body ?? {}) as any;
  if (typeof body.command !== "string" || body.command.length === 0) {
    reply.code(400);
    return { error: "command is required" };
  }
  const summary = ptys.spawn({
    name: typeof body.name === "string" ? body.name : undefined,
    command: body.command,
    args: Array.isArray(body.args) ? body.args.map(String) : [],
    cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    env: typeof body.env === "object" && body.env ? body.env : undefined,
    cols: Number.isFinite(body.cols) ? Number(body.cols) : undefined,
    rows: Number.isFinite(body.rows) ? Number(body.rows) : undefined,
  });
  store.upsertSession(summary);
  broadcast({ type: "pty_list", ptys: mergePtys(ptys.list(), store.listSessions()) });
  return { id: summary.id };
});

// Create an interactive login shell with zero UI configuration.
fastify.post("/api/ptys/shell", async () => {
  const shell = process.env.AGENT_TIDE_SHELL ?? process.env.SHELL ?? "bash";
  const tmuxSession = `agent_tide_${randomUUID()}`;
  await tmuxNewSessionDetached(tmuxSession, shell);

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
  broadcast({ type: "pty_list", ptys: mergePtys(ptys.list(), store.listSessions()) });
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
  const st = await fs.stat(filePath);
  const data = await fs.readFile(filePath);
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

wss.on("connection", (ws) => {
  const client = hub.add(ws);

  // Initial list.
  send(ws, { type: "pty_list", ptys: mergePtys(ptys.list(), store.listSessions()) });

  ws.on("message", (buf) => {
    let msg: ClientToServerMessage;
    try {
      msg = JSON.parse(buf.toString("utf-8")) as ClientToServerMessage;
    } catch {
      return;
    }

    if (msg.type === "subscribe") {
      client.subscribed.add(msg.ptyId);
      return;
    }
    if (msg.type === "input") {
      ptys.write(msg.ptyId, msg.data);
      return;
    }
    if (msg.type === "resize") {
      ptys.resize(msg.ptyId, msg.cols, msg.rows);
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

// Boot
await loadTriggersAndBroadcast("startup");
triggerLoader.watch(() => void loadTriggersAndBroadcast("watch"));
await restorePersistentTmuxSessions();

await fastify.listen({ host: HOST, port: PORT });
