import { describe, expect, test } from "vitest";
import {
  inferAgentFromProcessArgs,
  normalizeCommandName,
  pickForegroundProcess,
  validateShellExecutable,
} from "../src/tmux.js";

describe("normalizeCommandName", () => {
  test("canonicalizes node MainThread labels for wrapper matching", () => {
    expect(normalizeCommandName("node-MainThread")).toBe("node");
  });
});

describe("inferAgentFromProcessArgs", () => {
  test("detects codex when wrapped by node", () => {
    const args = "node /usr/local/lib/node_modules/@openai/codex/bin/codex.js --model gpt-5";
    expect(inferAgentFromProcessArgs(args)).toBe("codex");
  });

  test("detects claude when launched via bun", () => {
    const args = "bun /opt/agents/claude/index.ts --dangerously-skip-permissions";
    expect(inferAgentFromProcessArgs(args)).toBe("claude");
  });

  test("detects cursor-agent by direct command token", () => {
    const args = "npx cursor-agent --session abc123";
    expect(inferAgentFromProcessArgs(args)).toBe("cursor-agent");
  });

  test("returns null for unrelated runtime command lines", () => {
    const args = "node /srv/app/server.js --port 3000";
    expect(inferAgentFromProcessArgs(args)).toBeNull();
  });
});

describe("pickForegroundProcess", () => {
  test("prefers direct agent child over runtime wrapper group leader", () => {
    const selected = pickForegroundProcess([
      { pid: 101, pgid: 101, tpgid: 101, comm: "node-MainThread" },
      { pid: 102, pgid: 101, tpgid: 101, comm: "codex" },
    ], null);
    expect(selected).toEqual({ pid: 102, comm: "codex" });
  });

  test("falls back to wrapper when no direct foreground child exists", () => {
    const selected = pickForegroundProcess([
      { pid: 101, pgid: 101, tpgid: 101, comm: "node-MainThread" },
    ], null);
    expect(selected).toEqual({ pid: 101, comm: "node-MainThread" });
  });

  test("ignores shell processes", () => {
    const selected = pickForegroundProcess([
      { pid: 200, pgid: 200, tpgid: 200, comm: "zsh" },
      { pid: 201, pgid: 200, tpgid: 200, comm: "node-MainThread" },
      { pid: 202, pgid: 200, tpgid: 200, comm: "codex" },
    ], 200);
    expect(selected).toEqual({ pid: 202, comm: "codex" });
  });
});

describe("validateShellExecutable", () => {
  test("accepts a plain shell path", () => {
    expect(validateShellExecutable("/bin/bash")).toBe("/bin/bash");
  });

  test("trims surrounding whitespace", () => {
    expect(validateShellExecutable("  bash  ")).toBe("bash");
  });

  test("throws for empty string", () => {
    expect(() => validateShellExecutable("")).toThrow("shell must not be empty");
  });

  test("throws for whitespace-only string", () => {
    expect(() => validateShellExecutable("   ")).toThrow("shell must not be empty");
  });

  test("throws when shell starts with a dash (flag injection)", () => {
    expect(() => validateShellExecutable("-malicious")).toThrow("shell must not start with '-'");
  });

  test("throws for shell with embedded space (argument injection)", () => {
    expect(() => validateShellExecutable("/bin/bash -c rm")).toThrow("without arguments");
  });

  test("throws for shell containing NUL byte", () => {
    expect(() => validateShellExecutable("/bin/bas\u0000h")).toThrow("NUL byte");
  });
});
