import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SqliteStore } from "../src/persist/sqlite.js";

describe("SqliteStore session_task_assignments", () => {
  let tmpRoot: string | null = null;

  afterEach(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  function addSession(store: SqliteStore, id: string): void {
    store.upsertSession({
      id,
      name: `shell:${id}`,
      backend: "tmux",
      tmuxSession: `session:${id}`,
      tmuxServer: "agmux",
      command: "tmux",
      args: ["attach-session", "-t", "session"],
      cwd: `/tmp/${id}`,
      createdAt: 1_000,
      status: "running",
    });
  }

  test("assigning a task replaces the previous active assignment for that session", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-task-assign-"));
    const store = new SqliteStore(path.join(tmpRoot, "tasks.db"));
    addSession(store, "pty-1");

    store.assignTaskToSession({
      sessionId: "pty-1",
      projectRoot: "/tmp/project-a",
      provider: "beads",
      taskId: "A-1",
      assignedAt: 1_000,
    });
    store.assignTaskToSession({
      sessionId: "pty-1",
      projectRoot: "/tmp/project-a",
      provider: "beads",
      taskId: "A-2",
      assignedAt: 2_000,
    });

    const active = store.getActiveTaskAssignment("pty-1");
    expect(active).not.toBeNull();
    expect(active?.taskId).toBe("A-2");
    expect(active?.provider).toBe("beads");
    expect(active?.assignedAt).toBe(2_000);
    expect(active?.active).toBe(true);
  });

  test("clearTaskAssignment removes active assignment for a session", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-task-assign-"));
    const store = new SqliteStore(path.join(tmpRoot, "tasks.db"));
    addSession(store, "pty-2");

    store.assignTaskToSession({
      sessionId: "pty-2",
      projectRoot: "/tmp/project-b",
      provider: "beads",
      taskId: "B-1",
    });
    store.clearTaskAssignment("pty-2", 5_000);

    expect(store.getActiveTaskAssignment("pty-2")).toBeNull();
  });

  test("listActiveTaskAssignments filters by session id list", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-task-assign-"));
    const store = new SqliteStore(path.join(tmpRoot, "tasks.db"));
    addSession(store, "pty-3");
    addSession(store, "pty-4");

    store.assignTaskToSession({
      sessionId: "pty-3",
      projectRoot: "/tmp/project-c",
      provider: "beads",
      taskId: "C-1",
    });
    store.assignTaskToSession({
      sessionId: "pty-4",
      projectRoot: "/tmp/project-c",
      provider: "beads",
      taskId: "C-2",
    });

    const filtered = store.listActiveTaskAssignments(["pty-4"]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.sessionId).toBe("pty-4");
    expect(filtered[0]?.taskId).toBe("C-2");
  });
});
