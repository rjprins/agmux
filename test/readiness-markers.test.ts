import { describe, expect, it } from "vitest";
import {
  detectAgentOutputSignal,
  mergeAgentOutputTail,
  outputShowsAgentBusyMarker,
  outputShowsAgentPromptMarker,
  type AgentFamily,
} from "../src/readiness/markers.js";

function signal(chunk: string, family: AgentFamily | null): string {
  return detectAgentOutputSignal(chunk, family);
}

describe("readiness markers", () => {
  it("detects codex busy marker", () => {
    const chunk = "• Working (2s • esc to interrupt)\n";
    expect(outputShowsAgentBusyMarker(chunk, "codex")).toBe(true);
    expect(signal(chunk, "codex")).toBe("busy");
  });

  it("detects claude busy marker", () => {
    const chunk = "✶ Combobulating… (thinking)\n";
    expect(outputShowsAgentBusyMarker(chunk, "claude")).toBe(true);
    expect(signal(chunk, "claude")).toBe("busy");
  });

  it("detects codex prompt marker", () => {
    const chunk = "› status?\n\n100% context left\n";
    expect(outputShowsAgentPromptMarker(chunk, "codex")).toBe(true);
    expect(signal(chunk, "codex")).toBe("prompt");
  });

  it("detects claude prompt marker", () => {
    const chunk = "────────────────────────\n❯ status?\n────────────────────────\n? for shortcuts\n";
    expect(outputShowsAgentPromptMarker(chunk, "claude")).toBe(true);
    expect(signal(chunk, "claude")).toBe("prompt");
  });

  it("does not mark prompt from glyph alone", () => {
    const chunk = "› hello there\n";
    expect(outputShowsAgentPromptMarker(chunk, "codex")).toBe(false);
    expect(signal(chunk, "codex")).toBe("none");
  });

  it("handles ansi sequences in markers", () => {
    const chunk = "\u001b[1m›\u001b[0m ping\n\u001b[2m100% context left\u001b[0m\n";
    expect(signal(chunk, "codex")).toBe("prompt");
  });

  it("detects prompt with split chunks using history", () => {
    let tail = "";
    tail = mergeAgentOutputTail(tail, "• Committed.\n\n- Commit: 7258ccf\n");
    expect(signal(tail, "codex")).toBe("none");
    tail = mergeAgentOutputTail(tail, "› Use /skills to list available skills\n");
    expect(signal(tail, "codex")).toBe("none");
    tail = mergeAgentOutputTail(tail, "  ? for shortcuts                                    60% context left\n");
    expect(signal(tail, "codex")).toBe("prompt");
  });

  it("prioritizes busy marker over older prompt history", () => {
    let tail = "";
    tail = mergeAgentOutputTail(tail, "› status?\n100% context left\n");
    expect(signal(tail, "codex")).toBe("prompt");
    tail = mergeAgentOutputTail(tail, "• Working (2s • esc to interrupt)\n");
    expect(signal(tail, "codex")).toBe("busy");
  });

  it("classifies the commit-summary plus footer sample as prompt, not busy", () => {
    const sample = [
      "• Committed.",
      "",
      "  - Commit: 7258ccf",
      "  - Message: Remove shell hooks and simplify status visuals",
      "",
      "  Included in this commit:",
      "",
      "  - Removed shell-hook insertion/readiness handling from src/server.ts (pattern-based inference only).",
      "  - Removed unknown-state extra dot in src/ui/app.ts.",
      "  - Removed status-driven border effects in public/styles.css (no border-style/border-color shifts for ready/busy/unknown).",
      "",
      "  Checks:",
      "",
      "  - npm run -s build passed",
      "  - npm test passed",
      "",
      "  1 background terminal running · /ps to view · /clean to close",
      "",
      "› Use /skills to list available skills",
      "",
      "  ? for shortcuts                                                                                                    60% context left",
      "",
    ].join("\n");
    expect(signal(sample, "codex")).toBe("prompt");
  });
});
