import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [, , mode, ...args] = process.argv;

if (mode === "tree-parent") {
  const [pidFile] = args;
  const child = spawn(process.execPath, [import.meta.filename, "tree-child"], {
    stdio: "ignore",
  });
  writeFileSync(pidFile, `${process.pid}\n${child.pid}\n`);
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else if (mode === "tree-child") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else if (mode === "nonzero-parent") {
  const [pidFile] = args;
  const child = spawn(process.execPath, [import.meta.filename, "short-child"], {
    stdio: "ignore",
  });
  child.unref();
  writeFileSync(pidFile, `${child.pid}\n`);
  process.stderr.write("parent failed");
  process.exitCode = 7;
} else if (mode === "short-child") {
  await new Promise((resolve) => setTimeout(resolve, 300));
} else if (mode === "late-output-parent") {
  const child = spawn(process.execPath, [import.meta.filename, "late-output-child"], {
    stdio: ["ignore", "inherit", "ignore"],
  });
  child.unref();
} else if (mode === "late-output-child") {
  await new Promise((resolve) => setTimeout(resolve, 50));
  process.stdout.write(Buffer.alloc(65, "x"));
} else if (mode === "check-pids") {
  const [pidFile, survivorFile] = args;
  const pids = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
  const survivors = pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  if (survivors.length > 0) writeFileSync(survivorFile, survivors.join("\n"));
  process.stdout.write(JSON.stringify({ survivors }));
} else if (mode === "serialized") {
  const [lockFile, overlapFile, orderFile, id] = args;
  if (existsSync(lockFile)) writeFileSync(overlapFile, id);
  writeFileSync(lockFile, String(process.pid));
  appendFileSync(orderFile, `${id}\n`);
  await new Promise((resolve) => setTimeout(resolve, 75));
  unlinkSync(lockFile);
  process.stdout.write(JSON.stringify({ id }));
} else if (mode === "output") {
  const [stream, byteCount] = args;
  process[stream].write(Buffer.alloc(Number(byteCount), "x"));
} else if (mode === "fail") {
  process.stderr.write("fixture failure");
  process.exitCode = 7;
} else {
  process.stderr.write(`Unknown fixture mode: ${mode}\n`);
  process.exitCode = 2;
}
