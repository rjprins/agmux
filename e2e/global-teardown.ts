import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export default async function globalTeardown() {
  try {
    await execFileAsync("tmux", ["-L", "agmux-e2e", "kill-server"]);
  } catch {
    // Server already gone — nothing to clean up.
  }
}
