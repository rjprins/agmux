import type WebSocket from "ws";
import type { PtyId, ServerToClientMessage } from "../types.js";

type Client = {
  ws: WebSocket;
  subscribed: Set<PtyId>;
  // Output coalescing between flushes.
  outByPty: Map<PtyId, string>;
  queuedBytes: number;
};

export class WsHub {
  private clients = new Set<Client>();
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly flushEveryMs: number;
  private readonly maxBufferedAmount: number;
  private readonly maxQueuedOutputBytes: number;

  constructor(opts?: {
    flushEveryMs?: number;
    maxBufferedAmount?: number;
    maxQueuedOutputBytes?: number;
  }) {
    this.flushEveryMs = opts?.flushEveryMs ?? 16;
    this.maxBufferedAmount = opts?.maxBufferedAmount ?? 8 * 1024 * 1024;
    this.maxQueuedOutputBytes = opts?.maxQueuedOutputBytes ?? 1024 * 1024;
  }

  add(ws: WebSocket): Client {
    const client: Client = { ws, subscribed: new Set(), outByPty: new Map(), queuedBytes: 0 };
    this.clients.add(client);
    ws.on("close", () => this.clients.delete(client));
    ws.on("error", () => this.clients.delete(client));
    return client;
  }

  broadcast(evt: ServerToClientMessage): void {
    const payload = JSON.stringify(evt);
    for (const c of this.clients) {
      if (c.ws.readyState !== c.ws.OPEN) continue;
      if (c.ws.bufferedAmount > this.maxBufferedAmount) {
        try {
          c.ws.close(1011, "Client too slow");
        } catch {
          // ignore
        }
        continue;
      }
      c.ws.send(payload);
    }
  }

  queuePtyOutput(ptyId: PtyId, data: string): void {
    for (const c of this.clients) {
      if (c.ws.readyState !== c.ws.OPEN) continue;
      if (!c.subscribed.has(ptyId)) continue;
      const prev = c.outByPty.get(ptyId);
      if (prev) {
        c.queuedBytes -= Buffer.byteLength(prev, "utf8");
      }
      const next = (prev ?? "") + data;
      c.outByPty.set(ptyId, next);
      c.queuedBytes += Buffer.byteLength(next, "utf8");
      if (c.queuedBytes > this.maxQueuedOutputBytes) {
        this.closeSlowClient(c);
      }
    }
    this.ensureFlushTimer();
  }

  private ensureFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.flushEveryMs);
  }

  private flush(): void {
    for (const c of this.clients) {
      if (c.ws.readyState !== c.ws.OPEN) continue;
      if (c.ws.bufferedAmount > this.maxBufferedAmount) {
        this.closeSlowClient(c);
        continue;
      }

      for (const [ptyId, data] of c.outByPty) {
        if (!data) continue;
        const msg: ServerToClientMessage = { type: "pty_output", ptyId, data };
        c.ws.send(JSON.stringify(msg));
      }
      c.outByPty.clear();
      c.queuedBytes = 0;
    }
  }

  private closeSlowClient(c: Client): void {
    c.outByPty.clear();
    c.queuedBytes = 0;
    try {
      c.ws.close(1011, "Client too slow");
    } catch {
      // ignore
    }
  }
}
