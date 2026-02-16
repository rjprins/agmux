import stripAnsi from "strip-ansi";

export type AgentFamily = "codex" | "claude" | "other";
export type AgentOutputSignal = "busy" | "prompt" | "none";
const AGENT_TAIL_MAX_CHARS = 4000;

function recentVisibleLines(chunk: string, maxLines = 16): string[] {
  const tail = stripAnsi(chunk).replaceAll("\r", "\n").replaceAll("\u00a0", " ").slice(-1400);
  return tail
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-maxLines);
}

export function outputShowsAgentBusyMarker(chunk: string, family: AgentFamily | null): boolean {
  const lines = recentVisibleLines(chunk, 18);
  if (lines.length === 0) return false;

  const hasInterrupt = lines.some((line) => /\besc to interrupt\b/i.test(line));
  const hasCodexWorking = lines.some((line) => /^[•·●]?\s*working\b.*\besc to interrupt\b/i.test(line));
  const hasClaudeThinking = lines.some((line) =>
    /^[✶✻✢✳*]\s+.+\((?:thinking|analyzing|planning|reasoning)\)\s*$/iu.test(line),
  );

  if (family === "codex") return hasCodexWorking || (hasInterrupt && lines.some((line) => /\bworking\b/i.test(line)));
  if (family === "claude") return hasClaudeThinking;
  if (family === "other") return hasClaudeThinking || hasCodexWorking;
  return hasClaudeThinking || hasCodexWorking;
}

export function outputShowsAgentPromptMarker(chunk: string, family: AgentFamily | null): boolean {
  const lines = recentVisibleLines(chunk, 20);
  if (lines.length === 0) return false;

  const hasPromptInput = lines.some((line) => /^[›❯]\s*(?:$|\S.*)$/u.test(line));
  if (!hasPromptInput) return false;

  const hasContext = lines.some((line) => /\b\d{1,3}%\s+context left\b/i.test(line));
  const hasShortcuts = lines.some((line) => /\?\s+for shortcuts\b/i.test(line));
  const hasClaudeHeader = lines.some((line) => /\bClaude Code\b/i.test(line));
  const hasRuleLine = lines.some((line) => /^[─-]{20,}$/.test(line));

  if (family === "codex") return hasContext || hasShortcuts;
  if (family === "claude") return hasShortcuts || hasRuleLine || hasClaudeHeader;
  if (family === "other") return hasContext || hasShortcuts || hasRuleLine;
  return hasContext || hasShortcuts;
}

export function detectAgentOutputSignal(chunk: string, family: AgentFamily | null): AgentOutputSignal {
  if (outputShowsAgentBusyMarker(chunk, family)) return "busy";
  if (outputShowsAgentPromptMarker(chunk, family)) return "prompt";
  return "none";
}

export function mergeAgentOutputTail(previousTail: string, chunk: string, maxChars = AGENT_TAIL_MAX_CHARS): string {
  if (!previousTail) return chunk.length <= maxChars ? chunk : chunk.slice(-maxChars);
  const merged = `${previousTail}${chunk}`;
  return merged.length <= maxChars ? merged : merged.slice(-maxChars);
}
