import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import { execSync } from "node:child_process";

const repo = process.cwd();
const supDir = path.join(repo, "supervisor");

const appPort = Number(process.env.APP_PORT ?? 4821);
const supPort = Number(process.env.SUP_PORT ?? 4822);

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
  },
});

child.on("exit", (code) => process.exit(code ?? 1));
