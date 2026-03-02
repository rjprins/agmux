import stripAnsi from "strip-ansi";
import type { PtyId } from "../types.js";
import type { Trigger, TriggerHooks } from "./types.js";

type EmitFn = (evt: unknown) => void;
type WriteFn = (ptyId: PtyId, data: string) => void;

type PtyBuffers = {
  partial: string;
};

const DEFAULT_HOOKS: TriggerHooks = {
  writeTo: () => {},
  listPtys: () => [],
  spawnShell: async () => ({ ptyId: "", cwd: null, tmuxSession: null }),
};

export class TriggerEngine {
  private static readonly MAX_PARTIAL_CHARS = 64 * 1024;
  private triggers: Trigger[] = [];
  private lastFireByKey = new Map<string, number>();
  private buffers = new Map<PtyId, PtyBuffers>();

  setTriggers(triggers: Trigger[]): void {
    this.triggers = triggers;
  }

  onOutput(ptyId: PtyId, chunk: string, emit: EmitFn, write: WriteFn, hooks: TriggerHooks = DEFAULT_HOOKS): void {
    if (this.triggers.length === 0) return;

    const buf = this.buffers.get(ptyId) ?? { partial: "" };
    this.buffers.set(ptyId, buf);

    // Always run chunk-scope triggers on raw chunk (sanitized).
    const sanitizedChunk = stripAnsi(chunk);
    for (const t of this.triggers) {
      if ((t.scope ?? "line") !== "chunk") continue;
      this.runTrigger(t, ptyId, sanitizedChunk, sanitizedChunk, emit, write, hooks);
    }

    // Line buffer for line-scope triggers.
    buf.partial += sanitizedChunk;
    if (buf.partial.length > TriggerEngine.MAX_PARTIAL_CHARS) {
      buf.partial = buf.partial.slice(-TriggerEngine.MAX_PARTIAL_CHARS);
    }
    let idx: number;
    while ((idx = buf.partial.indexOf("\n")) !== -1) {
      const line = buf.partial.slice(0, idx + 1);
      buf.partial = buf.partial.slice(idx + 1);
      const trimmed = line.replace(/\r?\n$/, "");

      for (const t of this.triggers) {
        if ((t.scope ?? "line") !== "line") continue;
        this.runTrigger(t, ptyId, trimmed, trimmed, emit, write, hooks);
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
    hooks: TriggerHooks,
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
      const result = t.onMatch({
        ptyId,
        ts: now,
        match: m,
        line,
        emit,
        write: (data) => write(ptyId, data),
        hooks,
      });
      if (result instanceof Promise) {
        void result.catch((err: unknown) => {
          emit({
            type: "trigger_error",
            ptyId,
            trigger: t.name,
            ts: now,
            message: err instanceof Error ? err.message : String(err),
          });
        });
      }
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
