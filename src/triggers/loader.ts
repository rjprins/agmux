import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Trigger } from "./types.js";

export type TriggerLoadResult = { triggers: Trigger[]; version: number };

export class TriggerLoader {
  private triggersPath: string;
  private version = 0;
  private lastGood: Trigger[] = [];
  private watcher: FSWatcher | null = null;

  constructor(triggersPath: string) {
    this.triggersPath = triggersPath;
  }

  async load(): Promise<TriggerLoadResult> {
    this.version++;
    const fileUrl = pathToFileURL(this.triggersPath);
    // Cache-bust for hot reload.
    fileUrl.searchParams.set("v", String(this.version));

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mod = (await import(fileUrl.toString())) as any;
    const triggers: unknown = mod?.triggers ?? mod?.default ?? mod;

    if (!Array.isArray(triggers)) {
      throw new Error(
        `Trigger module must export { triggers: Trigger[] } or default Trigger[]. Got: ${typeof triggers}`,
      );
    }

    // Minimal runtime validation.
    for (const t of triggers) {
      if (!t || typeof t !== "object") throw new Error("Trigger must be an object");
      if (typeof (t as any).name !== "string") throw new Error("Trigger.name must be a string");
      if (!((t as any).pattern instanceof RegExp))
        throw new Error("Trigger.pattern must be a RegExp");
      if (typeof (t as any).onMatch !== "function")
        throw new Error("Trigger.onMatch must be a function");
    }

    this.lastGood = triggers as Trigger[];
    return { triggers: this.lastGood, version: this.version };
  }

  lastGoodTriggers(): Trigger[] {
    return this.lastGood;
  }

  watch(onChange: () => void): void {
    if (this.watcher) return;
    const dir = path.dirname(this.triggersPath);
    this.watcher = chokidar.watch(dir, { ignoreInitial: true });
    this.watcher.on("add", onChange);
    this.watcher.on("change", onChange);
    this.watcher.on("unlink", onChange);
  }

  async close(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
  }
}
