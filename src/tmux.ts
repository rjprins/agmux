import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function tmuxHasSession(name: string): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["has-session", "-t", name]);
    return true;
  } catch {
    return false;
  }
}

export async function tmuxNewSessionDetached(name: string, shell: string): Promise<void> {
  await execFileAsync("tmux", ["new-session", "-d", "-s", name, shell]);
}

export async function tmuxKillSession(name: string): Promise<void> {
  await execFileAsync("tmux", ["kill-session", "-t", name]);
}

