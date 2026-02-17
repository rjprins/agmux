import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { PtyReadinessState } from "../types.js";

const DEBOUNCE_MS = 2_000;
const STREAMING_GUARD_MS = 3_000;
const TAIL_BYTES = 8192;

type LogStateCallback = (ptyId: string, state: PtyReadinessState, reason: string) => void;

type WatchEntry = {
  ptyId: string;
  cwd: string;
  projectDir: string;
  logFile: string | null;
  watcher: fs.FSWatcher | null;
  debounceTimer: NodeJS.Timeout | null;
  disposed: boolean;
};

export class ClaudeLogWatcher {
  private readonly entries = new Map<string, WatchEntry>();
  private readonly onStateChange: LogStateCallback;

  constructor(opts: { onStateChange: LogStateCallback }) {
    this.onStateChange = opts.onStateChange;
  }

  async startWatching(ptyId: string, cwd: string): Promise<void> {
    const existing = this.entries.get(ptyId);
    if (existing && existing.cwd === cwd && !existing.disposed) return;
    if (existing) this.stopWatching(ptyId);

    const projectDir = cwdToClaudeProjectDir(cwd);
    const entry: WatchEntry = {
      ptyId,
      cwd,
      projectDir,
      logFile: null,
      watcher: null,
      debounceTimer: null,
      disposed: false,
    };
    this.entries.set(ptyId, entry);

    try {
      await fsp.access(projectDir);
    } catch {
      // No Claude project dir for this CWD — nothing to watch.
      return;
    }

    await this.resolveAndWatch(entry);
  }

  stopWatching(ptyId: string): void {
    const entry = this.entries.get(ptyId);
    if (!entry) return;
    entry.disposed = true;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    if (entry.watcher) {
      try {
        entry.watcher.close();
      } catch {
        // ignore
      }
    }
    this.entries.delete(ptyId);
  }

  dispose(): void {
    for (const ptyId of [...this.entries.keys()]) {
      this.stopWatching(ptyId);
    }
  }

  private async resolveAndWatch(entry: WatchEntry): Promise<void> {
    if (entry.disposed) return;

    const logFile = await findActiveLogFile(entry.projectDir);
    if (!logFile || entry.disposed) return;

    entry.logFile = logFile;

    // Do an initial parse.
    await this.parseAndEmit(entry);
    if (entry.disposed) return;

    this.attachWatcher(entry);
  }

  private attachWatcher(entry: WatchEntry): void {
    if (entry.disposed || !entry.logFile) return;
    if (entry.watcher) {
      try {
        entry.watcher.close();
      } catch {
        // ignore
      }
    }

    try {
      entry.watcher = fs.watch(entry.logFile, () => {
        this.scheduleParse(entry);
      });
      entry.watcher.on("error", () => {
        // File may have been removed; close gracefully.
        if (entry.watcher) {
          try {
            entry.watcher.close();
          } catch {
            // ignore
          }
          entry.watcher = null;
        }
      });
    } catch {
      // watch failed — no log tracking for this PTY.
    }
  }

  private scheduleParse(entry: WatchEntry): void {
    if (entry.disposed) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      void this.parseAndMaybeRotate(entry);
    }, DEBOUNCE_MS);
  }

  private async parseAndMaybeRotate(entry: WatchEntry): Promise<void> {
    if (entry.disposed) return;

    // Check for newer log file (handles session restarts).
    const latest = await findActiveLogFile(entry.projectDir);
    if (entry.disposed) return;

    if (latest && latest !== entry.logFile) {
      entry.logFile = latest;
      this.attachWatcher(entry);
    }

    await this.parseAndEmit(entry);
  }

  private async parseAndEmit(entry: WatchEntry): Promise<void> {
    if (entry.disposed || !entry.logFile) return;

    try {
      const result = await tailParseLastEntry(entry.logFile);
      if (entry.disposed || !result) return;
      this.onStateChange(entry.ptyId, result.state, result.reason);
    } catch {
      // Parse failed — don't emit, engine falls back to terminal detection.
    }
  }
}

/** Convert a working directory to Claude's project directory path. */
export function cwdToClaudeProjectDir(cwd: string): string {
  // Claude Code uses: ~/.claude/projects/ + slug
  // Slug: replace home dir prefix, prepend `-`, replace all `/` with `-`
  const home = os.homedir();
  let slug: string;
  if (cwd.startsWith(home)) {
    slug = "-" + cwd.slice(home.length).replace(/\//g, "-");
  } else {
    slug = "-" + cwd.replace(/\//g, "-");
  }
  // Remove trailing `-` if cwd ended with `/`
  if (slug.endsWith("-") && slug.length > 1) slug = slug.slice(0, -1);
  return path.join(home, ".claude", "projects", slug);
}

/** Find the most recently modified .jsonl file in a directory. */
export async function findActiveLogFile(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return null;
  }

  let bestPath: string | null = null;
  let bestMtime = 0;

  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const full = path.join(dir, name);
    try {
      const st = await fsp.stat(full);
      if (st.isFile() && st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        bestPath = full;
      }
    } catch {
      // skip inaccessible files
    }
  }

  return bestPath;
}

type ParsedState = { state: PtyReadinessState; reason: string };

/** Read the tail of a JSONL file and infer state from the last meaningful entry. */
export async function tailParseLastEntry(filePath: string): Promise<ParsedState | null> {
  let fd: fsp.FileHandle | null = null;
  try {
    fd = await fsp.open(filePath, "r");
    const st = await fd.stat();
    const size = st.size;
    if (size === 0) return null;

    const readSize = Math.min(TAIL_BYTES, size);
    const offset = size - readSize;
    const buf = Buffer.alloc(readSize);
    await fd.read(buf, 0, readSize, offset);
    const text = buf.toString("utf8");
    const fileMtime = st.mtimeMs;

    // Parse lines backwards to find last meaningful entry.
    const lines = text.split("\n").filter((l) => l.trim().length > 0);

    for (let i = lines.length - 1; i >= 0; i--) {
      let entry: unknown;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== "object") continue;

      const result = inferStateFromEntry(entry as Record<string, unknown>);
      if (!result) continue; // skip entry

      // Streaming guard: if result says ready but file modified very recently, treat as busy.
      if (result.state === "ready" && Date.now() - fileMtime < STREAMING_GUARD_MS) {
        return { state: "busy", reason: "log:streaming" };
      }

      return result;
    }

    return null;
  } catch {
    return null;
  } finally {
    if (fd) {
      try {
        await fd.close();
      } catch {
        // ignore
      }
    }
  }
}

/** Classify a single JSONL entry into a readiness state, or null to skip. */
export function inferStateFromEntry(entry: Record<string, unknown>): ParsedState | null {
  const type = entry.type as string | undefined;

  if (type === "system") {
    const subtype = entry.subtype as string | undefined;
    if (subtype === "turn_duration" || subtype === "stop_hook_summary") {
      return { state: "ready", reason: "log:turn-complete" };
    }
    // Other system subtypes: skip.
    return null;
  }

  if (type === "assistant") {
    const message = entry.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && (block as any).type === "tool_use") {
          return { state: "busy", reason: "log:tool-use" };
        }
      }
      // Text-only assistant message.
      return { state: "ready", reason: "log:assistant-text" };
    }
    // Fallback: treat as ready if no content array.
    return { state: "ready", reason: "log:assistant-text" };
  }

  if (type === "user") {
    const message = entry.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && (block as any).type === "tool_result") {
          return { state: "busy", reason: "log:tool-result" };
        }
      }
    }
    // Real user prompt.
    return { state: "busy", reason: "log:user-prompt" };
  }

  if (type === "progress") {
    return { state: "busy", reason: "log:progress" };
  }

  if (type === "file-history-snapshot") {
    return null; // skip
  }

  // Unknown type: skip.
  return null;
}
