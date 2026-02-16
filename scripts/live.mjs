import { spawn, execFile, execSync } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import fs from "node:fs";

const repo = process.cwd();
const supDir = path.join(repo, "supervisor");

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

const appPort = process.env.APP_PORT ? Number(process.env.APP_PORT) : await findFreePort();
const supPort = process.env.SUP_PORT ? Number(process.env.SUP_PORT) : await findFreePort();

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

// Only check explicitly requested ports; auto-discovered ones are known-free.
if (process.env.APP_PORT) checkPortAvailable(appPort);
if (process.env.SUP_PORT) checkPortAvailable(supPort);

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

// Open the browser once from the launcher.
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
  execFile(open[0], open[1], () => {});
}
