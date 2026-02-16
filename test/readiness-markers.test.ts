import { describe, expect, it } from "vitest";
import {
  detectAgentOutputSignal,
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
});
