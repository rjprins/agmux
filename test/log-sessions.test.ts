import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import {
  LogSessionDiscovery,
  discoverInactiveLogSessions,
} from "../src/logSessions.js";

async function writeJsonl(filePath: string, lines: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  await fs.writeFile(filePath, body, "utf8");
}

describe("discoverInactiveLogSessions", () => {
  let tmpRoot: string | null = null;

  afterEach(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  test("discovers claude/codex/pi sessions and skips codex subagent logs", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-logs-"));
    const claudeDir = path.join(tmpRoot, "claude");
    const codexDir = path.join(tmpRoot, "codex");
    const piDir = path.join(tmpRoot, "pi");

    await writeJsonl(path.join(claudeDir, "projects", "a", "claude-1.jsonl"), [
      { sessionId: "claude-1", cwd: "/tmp/project-alpha" },
    ]);
    await writeJsonl(path.join(codexDir, "sessions", "2026", "01", "codex-1.jsonl"), [
      { type: "session_meta", payload: { id: "codex-1", source: "cli", cwd: "/tmp/project-beta" } },
    ]);
    await writeJsonl(path.join(codexDir, "sessions", "2026", "01", "subagent.jsonl"), [
      { type: "session_meta", payload: { id: "codex-sub", source: { subagent: "review" }, cwd: "/tmp/review" } },
    ]);
    await writeJsonl(path.join(piDir, "agent", "sessions", "x", "pi-1.jsonl"), [
      { type: "session", id: "pi-1", payload: { working_directory: "/tmp/project-gamma" } },
    ]);

    const sessions = discoverInactiveLogSessions({
      claudeConfigDir: claudeDir,
      codexHomeDir: codexDir,
      piHomeDir: piDir,
      scanLimit: 50,
    });

    expect(sessions.map((s) => s.id)).toEqual(expect.arrayContaining([
      "log:claude:claude-1",
      "log:codex:codex-1",
      "log:pi:pi-1",
    ]));
    expect(sessions.find((s) => s.id === "log:claude:claude-1")?.args).toEqual(["--resume", "claude-1"]);
    expect(sessions.find((s) => s.id === "log:codex:codex-1")?.args).toEqual(["resume", "codex-1"]);
    expect(sessions.some((s) => s.id.includes("codex-sub"))).toBe(false);
    expect(sessions.every((s) => s.status === "exited")).toBe(true);
  });

  test("skips claude ancillary logs (file-history-snapshot / summary only)", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-logs-"));
    const claudeDir = path.join(tmpRoot, "claude");

    // Ancillary file-history-snapshot file (should be skipped)
    await writeJsonl(path.join(claudeDir, "projects", "a", "fh-only.jsonl"), [
      { type: "file-history-snapshot", snapshot: {} },
      { type: "file-history-snapshot", snapshot: {} },
    ]);

    // Ancillary summary + file-history-snapshot file (should be skipped)
    await writeJsonl(path.join(claudeDir, "projects", "a", "summary-fh.jsonl"), [
      { type: "summary", summary: "Some summary", leafUuid: "abc" },
      { type: "file-history-snapshot", snapshot: {} },
    ]);

    // Real session that starts with file-history-snapshot but has session data (should be kept)
    await writeJsonl(path.join(claudeDir, "projects", "a", "real-session.jsonl"), [
      { type: "file-history-snapshot", snapshot: {} },
      { type: "progress", sessionId: "real-1", cwd: "/tmp/real" },
      { type: "user", sessionId: "real-1", cwd: "/tmp/real" },
    ]);

    const sessions = discoverInactiveLogSessions({
      claudeConfigDir: claudeDir,
      codexHomeDir: path.join(tmpRoot, "codex"),
      piHomeDir: path.join(tmpRoot, "pi"),
      scanLimit: 50,
    });

    expect(sessions.some((s) => s.id.includes("fh-only"))).toBe(false);
    expect(sessions.some((s) => s.id.includes("summary-fh"))).toBe(false);
    expect(sessions.some((s) => s.id === "log:claude:real-1")).toBe(true);
    expect(sessions.find((s) => s.id === "log:claude:real-1")?.cwd).toBe("/tmp/real");
  });

  test("uses filename stem when session id is missing", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-logs-"));
    const claudeDir = path.join(tmpRoot, "claude");
    await writeJsonl(path.join(claudeDir, "projects", "a", "fallback-name.jsonl"), [
      { foo: "bar" },
      { cwd: "/tmp/project-fallback" },
    ]);

    const sessions = discoverInactiveLogSessions({
      claudeConfigDir: claudeDir,
      codexHomeDir: path.join(tmpRoot, "codex"),
      piHomeDir: path.join(tmpRoot, "pi"),
      scanLimit: 10,
    });

    expect(sessions[0]?.id).toBe("log:claude:fallback-name");
    expect(sessions[0]?.cwd).toBe("/tmp/project-fallback");
  });
});

describe("LogSessionDiscovery cache", () => {
  let tmpRoot: string | null = null;

  afterEach(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  test("reuses cached result until cache ttl expires", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-logs-"));
    const claudeDir = path.join(tmpRoot, "claude");
    const codexDir = path.join(tmpRoot, "codex");
    const piDir = path.join(tmpRoot, "pi");

    await writeJsonl(path.join(claudeDir, "projects", "a", "one.jsonl"), [
      { sessionId: "one", cwd: "/tmp/one" },
    ]);

    const discovery = new LogSessionDiscovery({
      claudeConfigDir: claudeDir,
      codexHomeDir: codexDir,
      piHomeDir: piDir,
      scanLimit: 50,
      cacheMs: 1000,
    });

    const at0 = discovery.list(10_000);
    expect(at0.some((s) => s.id === "log:claude:one")).toBe(true);

    await writeJsonl(path.join(claudeDir, "projects", "a", "two.jsonl"), [
      { sessionId: "two", cwd: "/tmp/two" },
    ]);

    const at500 = discovery.list(10_500);
    expect(at500.some((s) => s.id === "log:claude:two")).toBe(false);

    const at1501 = discovery.list(11_501);
    expect(at1501.some((s) => s.id === "log:claude:two")).toBe(true);
  });
});
