export type KnownWorktreeSummary = {
  name: string;
  path: string;
  branch: string;
};

export function findContainingWorktree(
  cwd: string | null,
  worktrees: KnownWorktreeSummary[],
): KnownWorktreeSummary | null {
  if (!cwd) return null;

  let bestMatch: KnownWorktreeSummary | null = null;
  for (const worktree of worktrees) {
    if (cwd !== worktree.path && !cwd.startsWith(worktree.path + "/")) continue;
    if (!bestMatch || worktree.path.length > bestMatch.path.length) {
      bestMatch = worktree;
    }
  }
  return bestMatch;
}

export function isMainWorktreeForCwd(
  cwd: string | null,
  worktrees: KnownWorktreeSummary[],
  repoRoot: string,
): boolean {
  if (!cwd || !repoRoot) return false;
  const match = findContainingWorktree(cwd, worktrees);
  return match?.path === repoRoot;
}
