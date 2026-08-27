import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createAzureCliRunner } from "../src/server/azure-cli.js";

const fixture = fileURLToPath(new URL("./fixtures/azure-cli-runner.mjs", import.meta.url));
const tempDirs: string[] = [];
const ownedPids = new Set<number>();

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agmux-azure-cli-test-"));
  tempDirs.push(dir);
  return dir;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(file) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!existsSync(file)) throw new Error(`Timed out waiting for ${file}`);
}

afterEach(() => {
  for (const pid of ownedPids) {
    if (!processExists(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  ownedPids.clear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Azure CLI runner", () => {
  it("kills the full process group when a command times out", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "pids");
    const survivorFile = path.join(dir, "survivors");
    const runAzureCli = createAzureCliRunner({
      command: process.execPath,
      timeoutMs: 200,
    });

    const timedOut = runAzureCli([fixture, "tree-parent", pidFile]);
    await waitForFile(pidFile);
    const successor = runAzureCli([fixture, "check-pids", pidFile, survivorFile]);

    await expect(timedOut).rejects.toThrow("timed out after 200ms");

    const pids = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
    pids.forEach((pid) => ownedPids.add(pid));

    expect(pids).toHaveLength(2);
    expect(pids.every((pid) => !processExists(pid))).toBe(true);
    await expect(successor).resolves.toMatchObject({ stdout: '{"survivors":[]}' });
    expect(existsSync(survivorFile)).toBe(false);
  });

  it("does not release the queue while a failed wrapper still has a descendant", async () => {
    if (process.platform === "win32") return;
    const dir = tempDir();
    const pidFile = path.join(dir, "pids");
    const survivorFile = path.join(dir, "survivors");
    const runAzureCli = createAzureCliRunner({
      command: process.execPath,
      timeoutMs: 2_000,
    });

    const failed = runAzureCli([fixture, "nonzero-parent", pidFile]);
    await waitForFile(pidFile);
    const successor = runAzureCli([fixture, "check-pids", pidFile, survivorFile]);

    await expect(failed).rejects.toThrow("code 7: parent failed");
    await expect(successor).resolves.toMatchObject({ stdout: '{"survivors":[]}' });
    expect(existsSync(survivorFile)).toBe(false);
  });

  it("serializes concurrent calls across runner handles", async () => {
    const dir = tempDir();
    const lockFile = path.join(dir, "lock");
    const overlapFile = path.join(dir, "overlap");
    const orderFile = path.join(dir, "order");
    const firstRunner = createAzureCliRunner({
      command: process.execPath,
      timeoutMs: 2_000,
    });
    const secondRunner = createAzureCliRunner({
      command: process.execPath,
      timeoutMs: 2_000,
    });

    const results = await Promise.all([
      firstRunner([fixture, "serialized", lockFile, overlapFile, orderFile, "first"]),
      secondRunner([fixture, "serialized", lockFile, overlapFile, orderFile, "second"]),
      firstRunner([fixture, "serialized", lockFile, overlapFile, orderFile, "third"]),
    ]);

    expect(results.map(({ stdout }) => JSON.parse(stdout))).toEqual([
      { id: "first" },
      { id: "second" },
      { id: "third" },
    ]);
    expect(readFileSync(orderFile, "utf8").trim().split("\n")).toEqual(["first", "second", "third"]);
    expect(existsSync(overlapFile)).toBe(false);
  });

  it("bounds both output streams by bytes and recovers the queue", async () => {
    const runAzureCli = createAzureCliRunner({
      command: process.execPath,
      timeoutMs: 2_000,
      maxBufferBytes: 64,
    });

    await expect(runAzureCli([fixture, "output", "stdout", "64"])).resolves.toMatchObject({
      stdout: "x".repeat(64),
    });
    await expect(runAzureCli([fixture, "output", "stdout", "65"])).rejects.toThrow("stdout exceeded 64 bytes");
    await expect(runAzureCli([fixture, "output", "stderr", "65"])).rejects.toThrow("stderr exceeded 64 bytes");
    await expect(runAzureCli([fixture, "fail"])).rejects.toThrow("code 7: fixture failure");
    await expect(runAzureCli([fixture, "output", "stdout", "2"])).resolves.toMatchObject({ stdout: "xx" });
  });

  it("recovers the queue after a command cannot be spawned", async () => {
    const missingCommand = createAzureCliRunner({ command: path.join(tempDir(), "missing-command") });
    const workingCommand = createAzureCliRunner({ command: process.execPath });

    await expect(missingCommand([])).rejects.toMatchObject({ code: "ENOENT" });
    await expect(workingCommand([fixture, "output", "stdout", "2"])).resolves.toMatchObject({ stdout: "xx" });
  });

  it("recovers after late output overflow when post-exit cleanup is confirmed", async () => {
    if (process.platform === "win32") return;
    const runAzureCli = createAzureCliRunner({
      command: process.execPath,
      timeoutMs: 2_000,
      maxBufferBytes: 64,
    });

    await expect(runAzureCli([fixture, "late-output-parent"])).rejects.toThrow("stdout exceeded 64 bytes");
    await expect(runAzureCli([fixture, "output", "stdout", "2"])).resolves.toMatchObject({ stdout: "xx" });
  });
});
