import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PtySummary } from "./types.js";

const LOG_HEAD_BYTE_LIMIT = 64 * 1024;
const LOG_HEAD_MAX_LIMIT = 1024 * 1024; // 1 MB

type LogSource = "claude" | "codex" | "pi";

type DiscoveryOptions = {
  enabled?: boolean;
  scanLimit?: number;
  claudeConfigDir?: string;
  codexHomeDir?: string;
  piHomeDir?: string;
};

type SearchRoot = {
  source: LogSource;
  dir: string;
  maxDepth: number;
};

type FileCandidate = {
  source: LogSource;
  logPath: string;
  mtimeMs: number;
  birthtimeMs: number;
};

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "";
}

function claudeConfigDir(options: DiscoveryOptions): string {
  return options.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(homeDir(), ".claude");
}

function codexHomeDir(options: DiscoveryOptions): string {
  return options.codexHomeDir ?? process.env.CODEX_HOME ?? path.join(homeDir(), ".codex");
}

function piHomeDir(options: DiscoveryOptions): string {
  return options.piHomeDir ?? process.env.PI_HOME ?? path.join(homeDir(), ".pi");
}

function getSearchRoots(options: DiscoveryOptions): SearchRoot[] {
  return [
    { source: "claude", dir: path.join(claudeConfigDir(options), "projects"), maxDepth: 3 },
    { source: "codex", dir: path.join(codexHomeDir(options), "sessions"), maxDepth: 4 },
    { source: "pi", dir: path.join(piHomeDir(options), "agent", "sessions"), maxDepth: 4 },
  ];
}

function safeParseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readLogHead(logPath: string, byteLimit = LOG_HEAD_BYTE_LIMIT): string {
  try {
    const fd = fs.openSync(logPath, "r");
    const buffer = Buffer.alloc(byteLimit);
    const bytes = fs.readSync(fd, buffer, 0, byteLimit, 0);
    fs.closeSync(fd);
    if (bytes <= 0) return "";
    return buffer.slice(0, bytes).toString("utf8");
  } catch {
    return "";
  }
}

function parseLogHeadEntries(
  logPath: string,
  initialLimit = LOG_HEAD_BYTE_LIMIT,
  maxLimit = LOG_HEAD_MAX_LIMIT,
): Array<Record<string, unknown>> {
  let byteLimit = initialLimit;
  while (byteLimit <= maxLimit) {
    const head = readLogHead(logPath, byteLimit);
    if (!head) return [];

    const lines = head.split("\n");
    const entries: Array<Record<string, unknown>> = [];
    let hadTruncatedLine = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]?.trim() ?? "";
      if (!line) continue;
      const parsed = safeParseJson(line);
      if (parsed) {
        entries.push(parsed);
      } else if (i === lines.length - 1 || (i === lines.length - 2 && !(lines[lines.length - 1]?.trim() ?? ""))) {
        hadTruncatedLine = true;
      }
    }
    if (entries.length > 0 && !hadTruncatedLine) return entries;
    if (hadTruncatedLine && byteLimit < maxLimit) {
      byteLimit = Math.min(byteLimit * 4, maxLimit);
      continue;
    }
    return entries;
  }
  return [];
}

function getSessionIdFromEntry(entry: Record<string, unknown>): string | null {
  if (typeof entry.sessionId === "string" && entry.sessionId.trim()) return entry.sessionId.trim();
  if (typeof entry.session_id === "string" && entry.session_id.trim()) return entry.session_id.trim();
  if (entry.type === "session" && typeof entry.id === "string" && entry.id.trim()) return entry.id.trim();

  if (entry.payload && typeof entry.payload === "object") {
    const payload = entry.payload as Record<string, unknown>;
    const candidate =
      typeof payload.id === "string"
        ? payload.id
        : typeof payload.sessionId === "string"
          ? payload.sessionId
          : typeof payload.session_id === "string"
            ? payload.session_id
            : null;
    if (candidate && candidate.trim()) return candidate.trim();
  }
  return null;
}

function getProjectPathFromEntry(entry: Record<string, unknown>): string | null {
  if (typeof entry.cwd === "string" && entry.cwd.trim()) return entry.cwd.trim();

  if (entry.payload && typeof entry.payload === "object") {
    const payload = entry.payload as Record<string, unknown>;
    const candidate =
      typeof payload.cwd === "string"
        ? payload.cwd
        : typeof payload.working_directory === "string"
          ? payload.working_directory
          : null;
    if (candidate && candidate.trim()) return candidate.trim();
  }
  return null;
}

function extractSessionId(entries: Array<Record<string, unknown>>): string | null {
  for (const entry of entries) {
    const sessionId = getSessionIdFromEntry(entry);
    if (sessionId) return sessionId;
  }
  return null;
}

function extractProjectPath(entries: Array<Record<string, unknown>>): string | null {
  for (const entry of entries) {
    const projectPath = getProjectPathFromEntry(entry);
    if (projectPath) return projectPath;
  }
  return null;
}

function isCodexSubagent(entries: Array<Record<string, unknown>>): boolean {
  const first = entries[0];
  if (!first || first.type !== "session_meta") return false;
  const payload = first.payload;
  if (!payload || typeof payload !== "object") return false;
  return typeof (payload as Record<string, unknown>).source === "object";
}

function scanDirForJsonl(root: string, maxDepth: number): string[] {
  if (!root || !fs.existsSync(root)) return [];

  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const paths: string[] = [];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const { dir, depth } = current;
    if (depth > maxDepth) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Matches Agentboard behavior: skip codex subagent nested logs.
        if (entry.name === "subagents") continue;
        if (depth < maxDepth) stack.push({ dir: fullPath, depth: depth + 1 });
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        paths.push(fullPath);
      }
    }
  }
  return paths;
}

function buildStableId(source: LogSource, sessionId: string, logPath: string): string {
  const trimmed = sessionId.trim();
  if (trimmed.length > 0) return `log:${source}:${trimmed}`;
  const digest = createHash("sha1").update(path.resolve(logPath)).digest("hex").slice(0, 16);
  return `log:${source}:file-${digest}`;
}

function leafOrDefault(projectPath: string | null, fallback: string): string {
  if (!projectPath) return fallback;
  const leaf = path.basename(projectPath);
  return leaf || fallback;
}

function resumeArgsForSource(source: LogSource, sessionId: string): string[] {
  if (source === "claude") return ["--resume", sessionId];
  return ["resume", sessionId];
}

export function discoverInactiveLogSessions(options: DiscoveryOptions = {}): PtySummary[] {
  if (options.enabled === false) return [];
  const scanLimit = Math.max(1, Math.floor(options.scanLimit ?? 500));
  const candidates: FileCandidate[] = [];

  for (const root of getSearchRoots(options)) {
    for (const logPath of scanDirForJsonl(root.dir, root.maxDepth)) {
      let stats: fs.Stats;
      try {
        stats = fs.statSync(logPath);
      } catch {
        continue;
      }
      if (!stats.isFile()) continue;
      candidates.push({
        source: root.source,
        logPath,
        mtimeMs: stats.mtimeMs,
        birthtimeMs: stats.birthtimeMs,
      });
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const limited = candidates.slice(0, scanLimit);
  const byId = new Map<string, PtySummary>();

  for (const candidate of limited) {
    const entries = parseLogHeadEntries(candidate.logPath);
    if (entries.length === 0) continue;
    if (candidate.source === "codex" && isCodexSubagent(entries)) continue;

    const derivedSessionId = extractSessionId(entries) ?? path.basename(candidate.logPath, ".jsonl");
    const projectPath = extractProjectPath(entries);
    const fallbackName = derivedSessionId.slice(0, 8) || "session";
    const summary: PtySummary = {
      id: buildStableId(candidate.source, derivedSessionId, candidate.logPath),
      name: `${candidate.source}:${leafOrDefault(projectPath, fallbackName)}`,
      command: candidate.source,
      args: resumeArgsForSource(candidate.source, derivedSessionId),
      cwd: projectPath,
      createdAt: Math.floor(candidate.birthtimeMs || candidate.mtimeMs || Date.now()),
      lastSeenAt: Math.floor(candidate.mtimeMs || Date.now()),
      status: "exited",
      exitCode: null,
      exitSignal: null,
    };

    const previous = byId.get(summary.id);
    if (!previous || (summary.lastSeenAt ?? summary.createdAt) > (previous.lastSeenAt ?? previous.createdAt)) {
      byId.set(summary.id, summary);
    }
  }

  return [...byId.values()].sort(
    (a, b) => (b.lastSeenAt ?? b.createdAt) - (a.lastSeenAt ?? a.createdAt),
  );
}

type CacheOptions = DiscoveryOptions & {
  cacheMs?: number;
};

export class LogSessionDiscovery {
  private readonly options: CacheOptions;
  private readonly cacheMs: number;
  private cachedAt = 0;
  private cached: PtySummary[] = [];

  constructor(options: CacheOptions = {}) {
    this.options = options;
    this.cacheMs = Math.max(250, Math.floor(options.cacheMs ?? 5000));
  }

  list(nowMs = Date.now()): PtySummary[] {
    if (this.options.enabled === false) return [];
    if (nowMs - this.cachedAt <= this.cacheMs && this.cached.length > 0) {
      return this.cached.map((session) => ({ ...session, args: [...session.args] }));
    }
    this.cached = discoverInactiveLogSessions(this.options);
    this.cachedAt = nowMs;
    return this.cached.map((session) => ({ ...session, args: [...session.args] }));
  }
}
