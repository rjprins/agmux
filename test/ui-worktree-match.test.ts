import { describe, expect, test } from "vitest";
import {
  findContainingWorktree,
  isMainWorktreeForCwd,
  type KnownWorktreeSummary,
} from "../src/ui/worktree-match.js";

const repoRoot = "/tmp/repo";

const worktrees: KnownWorktreeSummary[] = [
  { name: "main", path: repoRoot, branch: "main" },
  { name: "feature-a", path: "/tmp/repo/.worktrees/feature-a", branch: "feature-a" },
  { name: "nested", path: "/tmp/repo/nested-linked", branch: "nested" },
];

describe("findContainingWorktree", () => {
  test("matches the main worktree for a cwd under the repo root", () => {
    expect(findContainingWorktree("/tmp/repo/src/ui", worktrees)?.branch).toBe("main");
  });

  test("prefers the longest matching worktree path", () => {
    expect(findContainingWorktree("/tmp/repo/nested-linked/src", worktrees)?.branch).toBe("nested");
  });

  test("returns null when cwd is outside all known worktrees", () => {
    expect(findContainingWorktree("/tmp/other", worktrees)).toBeNull();
  });
});

describe("isMainWorktreeForCwd", () => {
  test("returns true for the main worktree", () => {
    expect(isMainWorktreeForCwd("/tmp/repo/src/ui", worktrees, repoRoot)).toBe(true);
  });

  test("returns false for linked worktrees", () => {
    expect(isMainWorktreeForCwd("/tmp/repo/.worktrees/feature-a/src", worktrees, repoRoot)).toBe(false);
  });
});
