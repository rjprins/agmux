import stripAnsi from "strip-ansi";
import {
  compileAgentPatternCatalog,
  type CompiledAgentPatternCatalog,
  type CompiledPatternMap,
} from "./patterns.js";

export type AgentFamily = "codex" | "claude" | "other";
export type AgentOutputSignal = "busy" | "prompt" | "none";
const AGENT_TAIL_MAX_CHARS = 4000;
const DEFAULT_PATTERNS = compileAgentPatternCatalog();

function recentVisibleLines(chunk: string, maxLines = 16): string[] {
  const tail = stripAnsi(chunk).replaceAll("\r", "\n").replaceAll("\u00a0", " ").slice(-1400);
  return tail
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-maxLines);
}

function hasPattern(lines: string[], patterns: CompiledPatternMap, id: string): boolean {
  const re = patterns.get(id);
  if (!re) return false;
  return lines.some((line) => re.test(line));
}

function hasBusy(lines: string[], id: string, patterns: CompiledAgentPatternCatalog): boolean {
  return hasPattern(lines, patterns.busy, id);
}

function hasPrompt(lines: string[], id: string, patterns: CompiledAgentPatternCatalog): boolean {
  return hasPattern(lines, patterns.prompt, id);
}

export function outputShowsAgentBusyMarker(
  chunk: string,
  family: AgentFamily | null,
  patterns: CompiledAgentPatternCatalog = DEFAULT_PATTERNS,
): boolean {
  const lines = recentVisibleLines(chunk, 18);
  if (lines.length === 0) return false;

  const hasInterrupt = hasBusy(lines, "busy_interrupt", patterns);
  const hasCodexWorking = hasBusy(lines, "busy_codex_working", patterns);
  const hasClaudeThinking = hasBusy(lines, "busy_claude_thinking", patterns);
  const hasWorkingWord = hasBusy(lines, "busy_working_word", patterns);

  if (family === "codex") return hasCodexWorking || (hasInterrupt && hasWorkingWord);
  if (family === "claude") return hasClaudeThinking;
  if (family === "other") return hasClaudeThinking || hasCodexWorking;
  return hasClaudeThinking || hasCodexWorking;
}

export function outputShowsAgentPromptMarker(
  chunk: string,
  family: AgentFamily | null,
  patterns: CompiledAgentPatternCatalog = DEFAULT_PATTERNS,
): boolean {
  const lines = recentVisibleLines(chunk, 20);
  if (lines.length === 0) return false;

  const hasPromptInput = hasPrompt(lines, "prompt_input", patterns);
  if (!hasPromptInput) return false;

  const hasContext = hasPrompt(lines, "prompt_context_left", patterns);
  const hasShortcuts = hasPrompt(lines, "prompt_shortcuts", patterns);
  const hasClaudeHeader = hasPrompt(lines, "prompt_claude_header", patterns);
  const hasRuleLine = hasPrompt(lines, "prompt_rule_line", patterns);

  if (family === "codex") return hasContext || hasShortcuts;
  if (family === "claude") return hasShortcuts || hasRuleLine || hasClaudeHeader;
  if (family === "other") return hasContext || hasShortcuts || hasRuleLine;
  return hasContext || hasShortcuts;
}

export function detectAgentOutputSignal(
  chunk: string,
  family: AgentFamily | null,
  patterns: CompiledAgentPatternCatalog = DEFAULT_PATTERNS,
): AgentOutputSignal {
  // Busy has precedence over prompt to avoid transient ready flicker while a tool is still streaming.
  if (outputShowsAgentBusyMarker(chunk, family, patterns)) return "busy";
  if (outputShowsAgentPromptMarker(chunk, family, patterns)) return "prompt";
  return "none";
}

export function mergeAgentOutputTail(previousTail: string, chunk: string, maxChars = AGENT_TAIL_MAX_CHARS): string {
  if (!previousTail) return chunk.length <= maxChars ? chunk : chunk.slice(-maxChars);
  const merged = `${previousTail}${chunk}`;
  return merged.length <= maxChars ? merged : merged.slice(-maxChars);
}
