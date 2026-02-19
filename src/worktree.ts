import path from "node:path";
import { execFileSync } from "node:child_process";

export const DEFAULT_WORKTREE_TEMPLATE = "../{repo-name}-{branch}";

export type WorktreeEntry = { path: string; branch: string };

let worktreeCache: WorktreeEntry[] = [];
let worktreeCacheTime = 0;
const WORKTREE_CACHE_TTL_MS = 30_000;

/**
 * Parse `git worktree list --porcelain` output into WorktreeEntry[].
 * Each block starts with `worktree <path>`, may have `branch refs/heads/<name>`,
 * separated by blank lines.
 */
export function parseWorktreeListPorcelain(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  const blocks = output.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    let entryPath = "";
    let branch = "";
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        entryPath = line.slice("worktree ".length);
      } else if (line.startsWith("branch refs/heads/")) {
        branch = line.slice("branch refs/heads/".length);
      }
    }
    if (entryPath) {
      entries.push({ path: entryPath, branch });
    }
  }
  return entries;
}

/**
 * Resolve a worktree path template against the repo root and branch name.
 */
export function resolveWorktreePath(repoRoot: string, branch: string, template: string): string {
  const sanitized = branch.replace(/[/\\ ]+/g, "-");
  const resolved = template
    .replace(/\{repo-name\}/g, path.basename(repoRoot))
    .replace(/\{repo-root\}/g, repoRoot)
    .replace(/\{branch\}/g, sanitized);
  return path.resolve(repoRoot, resolved);
}

/**
 * Refresh the worktree cache synchronously by running `git worktree list --porcelain`.
 */
export function refreshWorktreeCacheSync(repoRoot: string): void {
  try {
    const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    worktreeCache = parseWorktreeListPorcelain(output);
  } catch {
    worktreeCache = [];
  }
  worktreeCacheTime = Date.now();
}

/**
 * Get cached worktree list, refreshing if stale (>30s).
 */
export function getWorktreeCache(repoRoot: string): WorktreeEntry[] {
  if (Date.now() - worktreeCacheTime > WORKTREE_CACHE_TTL_MS) {
    refreshWorktreeCacheSync(repoRoot);
  }
  return worktreeCache;
}

/**
 * Extract worktree branch/name from a cwd path by matching against cache.
 * Returns null for the main worktree or unrelated paths.
 */
export function worktreeFromCwd(cwd: string | null, repoRoot: string): string | null {
  if (!cwd) return null;
  const cache = getWorktreeCache(repoRoot);
  for (const entry of cache) {
    // Skip main worktree
    if (entry.path === repoRoot) continue;
    if (cwd === entry.path || cwd.startsWith(entry.path + "/")) {
      return entry.branch || path.basename(entry.path);
    }
  }
  return null;
}

/**
 * Given a cwd, return the project root. If cwd is in a known worktree,
 * return repoRoot. Otherwise return cwd itself.
 */
export function projectRootFromCwd(cwd: string | null, repoRoot: string): string | null {
  if (!cwd) return null;
  const cache = getWorktreeCache(repoRoot);
  for (const entry of cache) {
    if (entry.path === repoRoot) continue;
    if (cwd === entry.path || cwd.startsWith(entry.path + "/")) {
      return repoRoot;
    }
  }
  return cwd;
}

/**
 * Check if a path matches any known worktree (excluding the main one).
 */
export function isKnownWorktree(checkPath: string, repoRoot: string): boolean {
  const resolved = path.resolve(checkPath);
  const cache = getWorktreeCache(repoRoot);
  for (const entry of cache) {
    if (entry.path === repoRoot) continue;
    if (resolved === entry.path) return true;
  }
  return false;
}

/**
 * Reset the cache (for testing).
 */
export function _resetCacheForTesting(): void {
  worktreeCache = [];
  worktreeCacheTime = 0;
}

/**
 * Set the cache directly (for testing).
 */
export function _setCacheForTesting(entries: WorktreeEntry[]): void {
  worktreeCache = entries;
  worktreeCacheTime = Date.now();
}
