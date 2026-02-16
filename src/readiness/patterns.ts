export type PatternEntry = {
  id: string;
  source: string;
  flags?: string;
};

export type AgentPatternCatalog = {
  busy: PatternEntry[];
  prompt: PatternEntry[];
};

export type AgentPatternOverrides = Partial<{
  busy: PatternEntry[];
  prompt: PatternEntry[];
}>;

export type CompiledPatternMap = ReadonlyMap<string, RegExp>;

export type CompiledAgentPatternCatalog = {
  busy: CompiledPatternMap;
  prompt: CompiledPatternMap;
};

export const DEFAULT_AGENT_PATTERN_CATALOG: AgentPatternCatalog = {
  busy: [
    { id: "busy_interrupt", source: "\\besc to interrupt\\b", flags: "i" },
    { id: "busy_codex_working", source: "^[•·●]?\\s*working\\b.*\\besc to interrupt\\b", flags: "i" },
    {
      id: "busy_claude_thinking",
      source: "^[✶✻✢✳*]\\s+.+\\((?:thinking|analyzing|planning|reasoning)\\)\\s*$",
      flags: "iu",
    },
    { id: "busy_working_word", source: "\\bworking\\b", flags: "i" },
  ],
  prompt: [
    { id: "prompt_input", source: "^[›❯]\\s*(?:$|\\S.*)$", flags: "u" },
    { id: "prompt_context_left", source: "\\b\\d{1,3}%\\s+context left\\b", flags: "i" },
    { id: "prompt_shortcuts", source: "\\?\\s+for shortcuts\\b", flags: "i" },
    { id: "prompt_claude_header", source: "\\bClaude Code\\b", flags: "i" },
    { id: "prompt_rule_line", source: "^[─-]{20,}$" },
  ],
};

function mergePatternEntries(base: PatternEntry[], overrides: PatternEntry[] | undefined): PatternEntry[] {
  if (!overrides || overrides.length === 0) return [...base];
  const merged = new Map<string, PatternEntry>();
  for (const p of base) merged.set(p.id, p);
  for (const p of overrides) merged.set(p.id, p);
  return [...merged.values()];
}

function compilePatternMap(entries: PatternEntry[]): CompiledPatternMap {
  const out = new Map<string, RegExp>();
  for (const entry of entries) {
    out.set(entry.id, new RegExp(entry.source, entry.flags));
  }
  return out;
}

export function compileAgentPatternCatalog(
  overrides: AgentPatternOverrides = {},
): CompiledAgentPatternCatalog {
  return {
    busy: compilePatternMap(mergePatternEntries(DEFAULT_AGENT_PATTERN_CATALOG.busy, overrides.busy)),
    prompt: compilePatternMap(mergePatternEntries(DEFAULT_AGENT_PATTERN_CATALOG.prompt, overrides.prompt)),
  };
}
