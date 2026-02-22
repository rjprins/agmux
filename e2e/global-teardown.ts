import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export default async function globalTeardown() {
  const tmuxSocket = process.env.E2E_TMUX_SOCKET ?? process.env.AGMUX_TMUX_SOCKET ?? "agmux-e2e";
  try {
    await execFileAsync("tmux", ["-L", tmuxSocket, "kill-server"]);
  } catch {
    // Server already gone — nothing to clean up.
  }
}
