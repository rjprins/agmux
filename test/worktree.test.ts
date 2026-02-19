import { describe, expect, test, beforeEach } from "vitest";
import {
  parseWorktreeListPorcelain,
  resolveWorktreePath,
  worktreeFromCwd,
  projectRootFromCwd,
  _resetCacheForTesting,
  _setCacheForTesting,
} from "../src/worktree.js";

describe("parseWorktreeListPorcelain", () => {
  test("parses main worktree + linked worktrees", () => {
    const output = [
      "worktree /home/user/repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /home/user/repo-feature",
      "HEAD def456",
      "branch refs/heads/feature/auth",
      "",
    ].join("\n");
    const entries = parseWorktreeListPorcelain(output);
    expect(entries).toEqual([
      { path: "/home/user/repo", branch: "main" },
      { path: "/home/user/repo-feature", branch: "feature/auth" },
    ]);
  });

  test("handles detached HEAD (no branch line)", () => {
    const output = [
      "worktree /home/user/repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /home/user/repo-detached",
      "HEAD def456",
      "detached",
      "",
    ].join("\n");
    const entries = parseWorktreeListPorcelain(output);
    expect(entries).toEqual([
      { path: "/home/user/repo", branch: "main" },
      { path: "/home/user/repo-detached", branch: "" },
    ]);
  });

  test("handles empty output", () => {
    expect(parseWorktreeListPorcelain("")).toEqual([]);
  });

  test("handles output without trailing newline", () => {
    const output = [
      "worktree /home/user/repo",
      "HEAD abc123",
      "branch refs/heads/main",
    ].join("\n");
    const entries = parseWorktreeListPorcelain(output);
    expect(entries).toEqual([
      { path: "/home/user/repo", branch: "main" },
    ]);
  });

  test("handles bare repository entry", () => {
    const output = [
      "worktree /home/user/repo.git",
      "HEAD abc123",
      "bare",
      "",
      "worktree /home/user/checkout",
      "HEAD def456",
      "branch refs/heads/main",
      "",
    ].join("\n");
    const entries = parseWorktreeListPorcelain(output);
    expect(entries).toEqual([
      { path: "/home/user/repo.git", branch: "" },
      { path: "/home/user/checkout", branch: "main" },
    ]);
  });
});

describe("resolveWorktreePath", () => {
  test("default sibling template", () => {
    const result = resolveWorktreePath("/home/user/repo", "feature/auth", "../{repo-name}-{branch}");
    expect(result).toBe("/home/user/repo-feature-auth");
  });

  test("sanitizes slashes, backslashes, and spaces in branch name", () => {
    const result = resolveWorktreePath("/home/user/repo", "feat/my branch\\fix", "../{repo-name}-{branch}");
    expect(result).toBe("/home/user/repo-feat-my-branch-fix");
  });

  test("absolute template path", () => {
    const result = resolveWorktreePath("/home/user/repo", "fix-bug", "/tmp/worktrees/{repo-name}/{branch}");
    expect(result).toBe("/tmp/worktrees/repo/fix-bug");
  });

  test("template with {repo-root}", () => {
    const result = resolveWorktreePath("/home/user/repo", "fix", "{repo-root}-wt/{branch}");
    expect(result).toBe("/home/user/repo-wt/fix");
  });

  test("relative template resolves against repo root", () => {
    const result = resolveWorktreePath("/home/user/repo", "fix", "worktrees/{branch}");
    expect(result).toBe("/home/user/repo/worktrees/fix");
  });
});

describe("worktreeFromCwd", () => {
  const repoRoot = "/home/user/repo";

  beforeEach(() => {
    _setCacheForTesting([
      { path: "/home/user/repo", branch: "main" },
      { path: "/home/user/repo-feature-auth", branch: "feature/auth" },
      { path: "/home/user/repo-fix-bug", branch: "fix-bug" },
    ]);
  });

  test("returns branch name when cwd matches worktree path exactly", () => {
    expect(worktreeFromCwd("/home/user/repo-feature-auth", repoRoot)).toBe("feature/auth");
  });

  test("returns branch name when cwd is subdirectory of worktree", () => {
    expect(worktreeFromCwd("/home/user/repo-feature-auth/src/lib", repoRoot)).toBe("feature/auth");
  });

  test("returns null for main worktree cwd", () => {
    expect(worktreeFromCwd("/home/user/repo", repoRoot)).toBeNull();
    expect(worktreeFromCwd("/home/user/repo/src", repoRoot)).toBeNull();
  });

  test("returns null for unrelated cwd", () => {
    expect(worktreeFromCwd("/tmp/other-project", repoRoot)).toBeNull();
  });

  test("returns null for null cwd", () => {
    expect(worktreeFromCwd(null, repoRoot)).toBeNull();
  });
});

describe("projectRootFromCwd", () => {
  const repoRoot = "/home/user/repo";

  beforeEach(() => {
    _setCacheForTesting([
      { path: "/home/user/repo", branch: "main" },
      { path: "/home/user/repo-feature-auth", branch: "feature/auth" },
    ]);
  });

  test("returns repo root when cwd is in a worktree", () => {
    expect(projectRootFromCwd("/home/user/repo-feature-auth", repoRoot)).toBe("/home/user/repo");
    expect(projectRootFromCwd("/home/user/repo-feature-auth/src", repoRoot)).toBe("/home/user/repo");
  });

  test("returns cwd itself when not in any worktree", () => {
    expect(projectRootFromCwd("/tmp/other-project", repoRoot)).toBe("/tmp/other-project");
  });

  test("returns null for null cwd", () => {
    expect(projectRootFromCwd(null, repoRoot)).toBeNull();
  });
});
