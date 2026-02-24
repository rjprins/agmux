import { describe, expect, test } from "vitest";
import { inferAgentFromProcessArgs } from "../src/tmux.js";

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

