import { execFile, execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repo = process.cwd();
const binExt = process.platform === "win32" ? ".cmd" : "";
const tscPath = path.join(repo, "node_modules", ".bin", `tsc${binExt}`);

const DEFAULT_PORT = 4821;
const requestedPort = Number(process.env.PORT ?? process.env.APP_PORT ?? String(DEFAULT_PORT));
const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : DEFAULT_PORT;

function checkPortAvailable(p) {
  try {
    const out = execSync("ss -ltnp", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const re = new RegExp(`:${p}(\\s|$)`);
    const lines = out.split("\n").filter((l) => re.test(l));
    if (lines.length === 0) return;

    console.error(`Port ${p} is already in use:\n${lines.join("\n")}\n`);
    console.error(`Stop the process using it, or pick a different port:\n  PORT=${p + 2} npm run dev\n`);
    process.exit(2);
  } catch {
    // If ss isn't available, we won't block startup.
  }
}

function spawnChild(cmd, args, label, extraEnv = {}) {
  const child = spawn(cmd, args, {
    cwd: repo,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`[dev] ${label} exited with signal ${signal}`);
    } else if (code && code !== 0) {
      console.error(`[dev] ${label} exited with code ${code}`);
    }
  });
  return child;
}

checkPortAvailable(port);

// Build UI once before starting the server.
console.log("[dev] Building UI...");
execSync("node scripts/build-ui.mjs", { cwd: repo, stdio: "inherit" });

// Watch src/ui/ for changes and rebuild UI automatically.
let rebuildTimer = null;
function scheduleRebuild() {
  if (rebuildTimer) return;
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    console.log("[dev] UI source changed, rebuilding...");
    try {
      execSync("node scripts/build-ui.mjs", { cwd: repo, stdio: "inherit" });
    } catch (err) {
      console.error("[dev] UI rebuild failed:", err.message);
    }
  }, 200);
}

try {
  const uiDir = path.join(repo, "src", "ui");
  fs.watch(uiDir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    if (filename.endsWith(".ts") || filename.endsWith(".tsx") || filename.endsWith(".css")) {
      scheduleRebuild();
    }
  });
} catch {
  console.warn("[dev] Could not watch src/ui/ for changes");
}

console.log("[dev] Starting TypeScript compiler in watch mode...");
const tsc = spawnChild(tscPath, ["-p", "tsconfig.json", "--watch"], "tsc");

// Start Node server with --watch (restarts on src/ changes, excluding src/ui/).
console.log("[dev] Starting server (watch mode)...");
const server = spawnChild(
  process.execPath,
  [
    "--watch",
    "--watch-path=src",
    "--watch-preserve-output",
    "--import",
    "tsx",
    "src/server.ts",
  ],
  "server",
  {
    PORT: String(port),
    // Prevent the Node server from opening a browser on every restart.
    AGMUX_NO_OPEN: "1",
  },
);

// Open the browser once the server is actually listening.
const appUrl = `http://127.0.0.1:${port}`;
console.log(`[dev] app: ${appUrl}`);

if (process.env.AGMUX_NO_OPEN !== "1") {
  const open =
    process.platform === "darwin"
      ? ["open", [appUrl]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", appUrl]]
        : ["xdg-open", [appUrl]];

  const poll = async () => {
    for (let i = 0; i < 120; i++) {
      try {
        const res = await fetch(appUrl);
        if (res.ok) return true;
      } catch {
        // Server not ready yet.
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  };
  poll().then((ok) => {
    if (ok) execFile(open[0], open[1], () => {});
  });
}

function shutdown(code) {
  if (!tsc.killed) tsc.kill("SIGINT");
  if (!server.killed) server.kill("SIGINT");
  process.exit(code);
}

tsc.on("exit", (code) => {
  if (code && code !== 0) shutdown(code);
});

server.on("exit", (code) => {
  if (code && code !== 0) shutdown(code);
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
