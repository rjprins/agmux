import stripAnsi from "strip-ansi";

const TMUX_DECORATIVE_LINE_PATTERN = /^[\s─━│┃┄┅┆┇┈┉┊┋┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬═╭╮╯╰▔▁]+$/;
const TMUX_METADATA_STATUS_PATTERNS: ReadonlyArray<RegExp> = [
  /context left/i,
  /background terminal running/i,
  /for shortcuts/i,
  /\/ps to view/i,
  /esc to interrupt/i,
];
const TMUX_TIMER_PATTERN = /\(\d+s[^)]*\)/g;
const TMUX_UI_GLYPH_PATTERN = /[•❯⏵⏺↵]/g;

// Permission prompt patterns for Claude Code and Codex CLI.
const PERMISSION_PATTERNS: ReadonlyArray<RegExp> = [
  /❯\s*\d+\.\s+\S+[\s\S]*?Esc to cancel/,
  /(?:^|\n)\s*[❯>]?\s*1\.\s*(Yes|Allow)(?!\s+\w+\s+\w+\s+\w+\s+\w+)/im,
  /do you want to (proceed|continue|allow|run)\?/i,
  /yes,?\s*(and\s+)?(don't|do not|never)\s+ask\s+again/i,
  /yes,?\s*(for|during)\s+this\s+session/i,
  /\[(approve|accept)\].*\[(reject|deny)\]/i,
  /approve\s+this\s+(command|change|action)/i,
  /\[allow\].*\[deny\]/i,
  /\?\s*\[?[yY](es)?\/[nN](o)?\]?\s*$/m,
];

export type PaneSnapshot = {
  content: string;
  width: number;
  height: number;
};

export type PaneCacheState = {
  content: string;
  width: number;
  height: number;
  lastChanged: number;
  hasEverChanged: boolean;
};

export type InferredPaneStatus = "waiting" | "working" | "permission";

export type InferPaneStatusArgs = {
  prev: PaneCacheState | undefined;
  next: PaneSnapshot;
  now: number;
  workingGracePeriodMs: number;
};

export type InferPaneStatusResult = {
  status: InferredPaneStatus;
  lastChanged: number;
  nextCache: PaneCacheState;
  nextCheckInMs: number | null;
};

function detectsPermissionPrompt(content: string): boolean {
  const cleaned = stripAnsi(content);
  const lines = cleaned.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  const recentContent = lines.slice(-10).join("\n");
  return PERMISSION_PATTERNS.some((pattern) => pattern.test(recentContent));
}

function normalizeContent(content: string): string {
  const lines = stripAnsi(content).split("\n");
  return lines
    .slice(-20)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !TMUX_DECORATIVE_LINE_PATTERN.test(line))
    .filter((line) => !TMUX_METADATA_STATUS_PATTERNS.some((pattern) => pattern.test(line)))
    .map((line) => line.replace(TMUX_TIMER_PATTERN, "").trim())
    .map((line) => line.replace(TMUX_UI_GLYPH_PATTERN, " ").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTokenOverlapStats(left: string, right: string): { ratioMin: number; leftSize: number; rightSize: number } {
  const leftTokens = left.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  const rightTokens = right.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  let overlap = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) overlap += 1;
  }
  const leftSize = leftSet.size;
  const rightSize = rightSet.size;
  const minSize = Math.min(leftSize, rightSize);
  const ratioMin = minSize === 0 ? 1 : overlap / minSize;
  return { ratioMin, leftSize, rightSize };
}

function isMeaningfulResizeChange(oldContent: string, newContent: string): boolean {
  if (oldContent === newContent) return false;
  const oldNormalized = normalizeContent(oldContent);
  const newNormalized = normalizeContent(newContent);
  if (oldNormalized === newNormalized) return false;
  const stats = getTokenOverlapStats(oldNormalized, newNormalized);
  if (Math.max(stats.leftSize, stats.rightSize) < 8) return true;
  return stats.ratioMin < 0.9;
}

export function inferPaneStatus(args: InferPaneStatusArgs): InferPaneStatusResult {
  const { prev, next, now, workingGracePeriodMs } = args;
  const { content, width, height } = next;

  let contentChanged = false;
  if (prev) {
    const dimensionsChanged = prev.width !== width || prev.height !== height;
    contentChanged = dimensionsChanged ? isMeaningfulResizeChange(prev.content, content) : prev.content !== content;
  }

  const hasEverChanged = contentChanged || prev?.hasEverChanged === true;
  const lastChanged = contentChanged ? now : (prev?.lastChanged ?? now);
  const nextCache: PaneCacheState = { content, width, height, lastChanged, hasEverChanged };
  const hasPermissionPrompt = detectsPermissionPrompt(content);

  if (!prev && !hasPermissionPrompt) {
    return { status: "waiting", lastChanged, nextCache, nextCheckInMs: null };
  }

  if (contentChanged) {
    return {
      status: "working",
      lastChanged,
      nextCache,
      nextCheckInMs: Math.max(100, workingGracePeriodMs),
    };
  }

  if (hasPermissionPrompt) {
    return { status: "permission", lastChanged, nextCache, nextCheckInMs: null };
  }

  const timeSinceLastChange = now - lastChanged;
  if (hasEverChanged && timeSinceLastChange < workingGracePeriodMs) {
    return {
      status: "working",
      lastChanged,
      nextCache,
      nextCheckInMs: Math.max(100, workingGracePeriodMs - timeSinceLastChange),
    };
  }

  return { status: "waiting", lastChanged, nextCache, nextCheckInMs: null };
}
