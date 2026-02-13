import stripAnsi from "strip-ansi";
import type { PtyId } from "../types.js";
import type { Trigger } from "./types.js";

type EmitFn = (evt: unknown) => void;
type WriteFn = (ptyId: PtyId, data: string) => void;

type PtyBuffers = {
  partial: string;
};

export class TriggerEngine {
  private triggers: Trigger[] = [];
  private lastFireByKey = new Map<string, number>();
  private buffers = new Map<PtyId, PtyBuffers>();

  setTriggers(triggers: Trigger[]): void {
    this.triggers = triggers;
  }

  onOutput(ptyId: PtyId, chunk: string, emit: EmitFn, write: WriteFn): void {
    if (this.triggers.length === 0) return;

    const buf = this.buffers.get(ptyId) ?? { partial: "" };
    this.buffers.set(ptyId, buf);

    // Always run chunk-scope triggers on raw chunk (sanitized).
    const sanitizedChunk = stripAnsi(chunk);
    for (const t of this.triggers) {
      if ((t.scope ?? "line") !== "chunk") continue;
      this.runTrigger(t, ptyId, sanitizedChunk, sanitizedChunk, emit, write);
    }

    // Line buffer for line-scope triggers.
    buf.partial += sanitizedChunk;
    let idx: number;
    while ((idx = buf.partial.indexOf("\n")) !== -1) {
      const line = buf.partial.slice(0, idx + 1);
      buf.partial = buf.partial.slice(idx + 1);
      const trimmed = line.replace(/\r?\n$/, "");

      for (const t of this.triggers) {
        if ((t.scope ?? "line") !== "line") continue;
        this.runTrigger(t, ptyId, trimmed, trimmed, emit, write);
      }
    }
  }

  private runTrigger(
    t: Trigger,
    ptyId: PtyId,
    matchTarget: string,
    line: string,
    emit: EmitFn,
    write: WriteFn,
  ): void {
    const m = matchTarget.match(t.pattern);
    if (!m) return;

    const now = Date.now();
    const key = `${ptyId}:${t.name}`;
    const cooldown = t.cooldownMs ?? 0;
    const last = this.lastFireByKey.get(key) ?? 0;
    if (cooldown > 0 && now - last < cooldown) return;
    this.lastFireByKey.set(key, now);

    try {
      t.onMatch({
        ptyId,
        ts: now,
        match: m,
        line,
        emit,
        write: (data) => write(ptyId, data),
      });
    } catch (err) {
      emit({
        type: "trigger_error",
        ptyId,
        trigger: t.name,
        ts: now,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

