import { spawn, execFile, execSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import fs from "node:fs";

const repo = process.cwd();
const supDir = path.join(repo, "supervisor");
const DEFAULT_APP_PORT = 4821;
const DEFAULT_SUP_PORT = 4822;
const requestedAppPort = Number(process.env.APP_PORT ?? String(DEFAULT_APP_PORT));
const requestedSupPort = Number(process.env.SUP_PORT ?? String(DEFAULT_SUP_PORT));
const appPort = Number.isInteger(requestedAppPort) && requestedAppPort > 0 ? requestedAppPort : DEFAULT_APP_PORT;
const supPort = Number.isInteger(requestedSupPort) && requestedSupPort > 0 ? requestedSupPort : DEFAULT_SUP_PORT;
if (appPort === supPort) {
  // eslint-disable-next-line no-console
  console.error(`APP_PORT and SUP_PORT must differ (both are ${appPort}).`);
  process.exit(2);
}

function checkPortAvailable(port) {
  try {
    const out = execSync("ss -ltnp", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const re = new RegExp(`:${port}(\\s|$)`);
    const lines = out.split("\n").filter((l) => re.test(l));
    if (lines.length === 0) return;

    // eslint-disable-next-line no-console
    console.error(`Port ${port} is already in use:\n${lines.join("\n")}\n`);
    // eslint-disable-next-line no-console
    console.error(
      `Stop the process using it, or pick different ports:\n` +
        `  APP_PORT=4823 SUP_PORT=4824 npm run live\n`,
    );
    process.exit(2);
  } catch {
    // If ss isn't available, we won't block startup; Go/Node will error clearly.
  }
}

checkPortAvailable(appPort);
checkPortAvailable(supPort);

const goCache = process.env.GOCACHE ?? "/tmp/go-build-cache";
try {
  fs.mkdirSync(goCache, { recursive: true });
} catch {
  // ignore
}

const args = [
  "run",
  ".",
  "-repo",
  repo,
  "-app-port",
  String(appPort),
  "-sup-port",
  String(supPort),
];

const child = spawn("go", args, {
  cwd: supDir,
  stdio: "inherit",
  env: {
    ...process.env,
    GOCACHE: goCache,
    // Prevent the Node server from opening a browser on every supervisor restart.
    AGENT_TIDE_NO_OPEN: "1",
  },
});

child.on("exit", (code) => process.exit(code ?? 1));

// Open the browser once the server is actually listening.
const appUrl = `http://127.0.0.1:${appPort}`;
// eslint-disable-next-line no-console
console.log(`app: ${appUrl}`);

if (process.env.AGENT_TIDE_NO_OPEN !== "1") {
  const open =
    process.platform === "darwin"
      ? ["open", [appUrl]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", appUrl]]
        : ["xdg-open", [appUrl]];

  // Poll until the server responds before opening the browser.
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
