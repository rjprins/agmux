import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import type { FastifyInstance } from "fastify";

import type { ClientToServerMessage, ServerToClientMessage } from "../types.js";
import type { PtyManager } from "../pty/manager.js";
import type { ReadinessEngine } from "../readiness/engine.js";
import type { WsHub } from "../ws/hub.js";
import { tmuxCapturePaneVisible, tmuxScrollHistory } from "../tmux.js";
import { AUTH_ENABLED } from "./config.js";
import { isRecord } from "./utils.js";
import { isTokenValid, isWsOriginAllowed, parseTokenFromHeaders, parseTokenFromUrl } from "./auth.js";

type WsDeps = {
  fastify: FastifyInstance;
  hub: WsHub;
  ptys: PtyManager;
  readinessEngine: ReadinessEngine;
  listPtys: () => Promise<unknown>;
};

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
    return { type: "resize", ptyId: parsed.ptyId, cols, rows };
  }
  if (parsed.type === "tmux_control") {
    if (typeof parsed.ptyId !== "string" || parsed.ptyId.length === 0) return null;
    const direction = parsed.direction;
    const lines = parsed.lines;
    if (direction !== "up" && direction !== "down") return null;
    if (typeof lines !== "number" || !Number.isInteger(lines)) return null;
    if (lines < 1 || lines > 200) return null;
    return { type: "tmux_control", ptyId: parsed.ptyId, direction, lines };
  }
  return null;
}

export function registerWs(deps: WsDeps): void {
  const { fastify, hub, ptys, readinessEngine, listPtys } = deps;
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    const client = hub.add(ws);

    void listPtys()
      .then((items) => send(ws, { type: "pty_list", ptys: items as any }))
      .catch(() => send(ws, { type: "pty_list", ptys: ptys.list() as any }));

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
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
  });
}
