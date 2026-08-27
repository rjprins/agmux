import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const PROCESS_EXIT_POLL_MS = 10;
const PROCESS_CLEANUP_TIMEOUT_MS = 2_000;

export type AzureCliResult = { stdout: string; stderr: string };

export type AzureCliRunnerOptions = {
  command?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
};

class AzureCliCleanupError extends Error {
  override name = "AzureCliCleanupError";
}

let queueTail = Promise.resolve();
let cleanupFailure: AzureCliCleanupError | null = null;

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processGroupExists(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if (errno(error) === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(
  groupId: number,
  failureMessage: string,
  deadline = Date.now() + PROCESS_CLEANUP_TIMEOUT_MS,
): Promise<void> {
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new AzureCliCleanupError(failureMessage);
    if (!processGroupExists(groupId)) return;
    await delay(Math.min(PROCESS_EXIT_POLL_MS, remainingMs));
  }
}

async function waitForProcessExit(pid: number, deadline: number): Promise<void> {
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new AzureCliCleanupError(`Azure CLI process ${pid} survived tree termination`);
    }
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (errno(error) === "ESRCH") return;
      throw error;
    }
    await delay(Math.min(PROCESS_EXIT_POLL_MS, remainingMs));
  }
}

async function runTaskkill(pid: number, deadline: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const taskkill = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      taskkill.kill("SIGKILL");
      finish(new AzureCliCleanupError(`taskkill timed out while terminating Azure CLI process ${pid}`));
    }, Math.max(0, deadline - Date.now()));
    taskkill.once("error", finish);
    taskkill.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`taskkill exited with code ${code ?? "unknown"}`));
    });
  });
}

async function terminateProcessTree(child: { pid?: number }): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const deadline = Date.now() + PROCESS_CLEANUP_TIMEOUT_MS;

  if (process.platform === "win32") {
    try {
      await runTaskkill(pid, deadline);
    } catch (error) {
      if (errno(error) !== "ESRCH") throw error;
    }
    await waitForProcessExit(pid, deadline);
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (errno(error) !== "ESRCH") throw error;
  }
  await waitForProcessGroupExit(pid, `Azure CLI process group ${pid} survived SIGKILL`, deadline);
}

function commandError(code: number | null, signal: NodeJS.Signals | null, stderr: string): Error {
  const status = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
  const detail = stderr.trim();
  return new Error(`Azure CLI exited with ${status}${detail ? `: ${detail}` : ""}`);
}

function execute(
  command: string,
  args: string[],
  timeoutMs: number,
  maxBufferBytes: number,
): Promise<AzureCliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdoutChunks: Buffer[] = [];
    let stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | null = null;
    let settled = false;
    let exited = false;
    let terminationStarted = false;
    let exitCheck: Promise<void> | null = null;
    let closeTimeout: NodeJS.Timeout | null = null;

    const clearTimers = (): void => {
      clearTimeout(timeout);
      if (closeTimeout) clearTimeout(closeTimeout);
    };

    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    };

    const rejectCleanupFailure = (error: unknown): void => {
      const fatal = error instanceof AzureCliCleanupError
        ? error
        : new AzureCliCleanupError(`Could not terminate Azure CLI process tree: ${String(error)}`);
      cleanupFailure = fatal;
      rejectOnce(fatal);
    };

    const failAndTerminate = (error: Error): void => {
      if (failure || settled) return;
      failure = error;
      if (exited) return;
      terminationStarted = true;
      const pendingCleanup = terminateProcessTree(child);
      void pendingCleanup.then(
        () => rejectOnce(error),
        rejectCleanupFailure,
      );
    };

    const timeout = setTimeout(() => {
      failAndTerminate(new Error(`Azure CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBufferBytes) {
        stdoutChunks = [];
        failAndTerminate(new Error(`Azure CLI stdout exceeded ${maxBufferBytes} bytes`));
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (failure) return;
      stderrBytes += chunk.length;
      if (stderrBytes > maxBufferBytes) {
        stderrChunks = [];
        failAndTerminate(new Error(`Azure CLI stderr exceeded ${maxBufferBytes} bytes`));
        return;
      }
      stderrChunks.push(chunk);
    });

    const settleClose = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
      if (settled || terminationStarted) return;
      if (closeTimeout) clearTimeout(closeTimeout);
      try {
        if (exitCheck) await exitCheck;
      } catch (error) {
        rejectCleanupFailure(error);
        return;
      }
      if (failure) {
        rejectOnce(failure);
        return;
      }
      const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8");
      const stderr = Buffer.concat(stderrChunks, stderrBytes).toString("utf8");
      if (code !== 0) {
        rejectOnce(commandError(code, signal, stderr));
        return;
      }
      settled = true;
      clearTimers();
      resolve({ stdout, stderr });
    };

    child.once("error", (error) => {
      if (child.pid === undefined) {
        failure ??= error;
        rejectOnce(error);
      } else {
        failAndTerminate(error);
      }
    });
    child.once("exit", () => {
      exited = true;
      clearTimeout(timeout);
      if (failure || settled || child.pid === undefined) return;
      exitCheck = process.platform === "win32"
        ? Promise.resolve()
        : waitForProcessGroupExit(
            child.pid,
            `Azure CLI process group ${child.pid} remained active after its leader exited`,
          );
      void exitCheck.catch(rejectCleanupFailure);
      closeTimeout = setTimeout(() => {
        rejectCleanupFailure(new AzureCliCleanupError(
          `Azure CLI output pipes remained open after process ${child.pid} exited`,
        ));
      }, PROCESS_CLEANUP_TIMEOUT_MS);
    });
    child.once("close", (code, signal) => void settleClose(code, signal));
  });
}

/** Create a handle backed by the one process-wide Azure CLI queue. */
export function createAzureCliRunner(options: AzureCliRunnerOptions = {}) {
  const command = options.command ?? "az";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

  return (args: string[]): Promise<AzureCliResult> => {
    const result = queueTail.then(() => {
      if (cleanupFailure) {
        throw new Error("Azure CLI disabled after incomplete process-tree cleanup", { cause: cleanupFailure });
      }
      return execute(command, args, timeoutMs, maxBufferBytes);
    });
    queueTail = result.then(() => undefined, () => undefined);
    return result;
  };
}

/** Run an Azure CLI command after every earlier Azure CLI command has fully finished. */
export const runAzureCli = createAzureCliRunner();
