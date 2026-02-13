import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import fs from "node:fs";

const repo = process.cwd();

const appPort = Number(process.env.APP_PORT ?? 4821);
const supPort = Number(process.env.SUP_PORT ?? 4822);

const goCache = process.env.GOCACHE ?? "/tmp/go-build-cache";
try {
  fs.mkdirSync(goCache, { recursive: true });
} catch {
  // ignore
}

const args = [
  "run",
  path.join(repo, "supervisor"),
  "-repo",
  repo,
  "-app-port",
  String(appPort),
  "-sup-port",
  String(supPort),
];

const child = spawn("go", args, {
  stdio: "inherit",
  env: {
    ...process.env,
    GOCACHE: goCache,
  },
});

child.on("exit", (code) => process.exit(code ?? 1));

