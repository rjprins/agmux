import { spawn, execFile, execSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import fs from "node:fs";

const repo = process.cwd();
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
    console.error(`Stop the process using it, or pick a different port:\n  PORT=${p + 2} npm run live\n`);
    process.exit(2);
  } catch {
    // If ss isn't available, we won't block startup.
  }
}

checkPortAvailable(port);

// Build UI once before starting the server.
console.log("[live] Building UI...");
execSync("node scripts/build-ui.mjs", { cwd: repo, stdio: "inherit" });

// Watch src/ui/ for changes and rebuild UI automatically.
import("node:fs").then(({ watch }) => {
  const uiDir = path.join(repo, "src", "ui");
  let rebuildTimer = null;

  function scheduleRebuild() {
    if (rebuildTimer) return;
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      console.log("[live] UI source changed, rebuilding...");
      try {
        execSync("node scripts/build-ui.mjs", { cwd: repo, stdio: "inherit" });
      } catch (err) {
        console.error("[live] UI rebuild failed:", err.message);
      }
    }, 200);
  }

  try {
    fs.watch(uiDir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (filename.endsWith(".ts") || filename.endsWith(".tsx") || filename.endsWith(".css")) {
        scheduleRebuild();
      }
    });
  } catch {
    console.warn("[live] Could not watch src/ui/ for changes");
  }
});

// Start Node server with --watch (restarts on src/ changes, excluding src/ui/).
const child = spawn(
  process.execPath,
  [
    "--watch",
    "--watch-path=src",
    "--watch-preserve-output",
    "--import", "tsx",
    "src/server.ts",
  ],
  {
    cwd: repo,
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: String(port),
      // Prevent the Node server from opening a browser on every restart.
      AGMUX_NO_OPEN: "1",
    },
  },
);

child.on("exit", (code) => process.exit(code ?? 1));

// Open the browser once the server is actually listening.
const appUrl = `http://127.0.0.1:${port}`;
console.log(`[live] app: ${appUrl}`);

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
