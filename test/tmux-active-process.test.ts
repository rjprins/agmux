import { describe, expect, test } from "vitest";
import { inferAgentFromProcessArgs, validateShellExecutable } from "../src/tmux.js";

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

