import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Keep agent-tide sessions isolated from any user tmux server.
// - `-L <socket>`: use a dedicated server socket name
// - `-f /dev/null`: do not load user config; we set options explicitly
const TMUX_SOCKET = "agent_tide";
const TMUX_BASE_ARGS = ["-L", TMUX_SOCKET, "-f", "/dev/null"] as const;

export type TmuxServer = "agent_tide" | "default";

async function tmuxAgent(args: string[]): Promise<void> {
  await execFileAsync("tmux", [...TMUX_BASE_ARGS, ...args]);
}

async function tmuxDefault(args: string[]): Promise<void> {
  await execFileAsync("tmux", args);
}

export async function tmuxLocateSession(name: string): Promise<TmuxServer | null> {
  try {
    await tmuxAgent(["has-session", "-t", name]);
    return "agent_tide";
  } catch {
    // fall through
  }

  try {
    await tmuxDefault(["has-session", "-t", name]);
    return "default";
  } catch {
    return null;
  }
}

export function tmuxAttachArgs(name: string, server: TmuxServer = "agent_tide"): string[] {
  if (server === "default") return ["attach-session", "-t", name];
  return [...TMUX_BASE_ARGS, "attach-session", "-t", name];
}

export async function tmuxHasSession(name: string): Promise<boolean> {
  return (await tmuxLocateSession(name)) != null;
}

export async function tmuxNewSessionDetached(name: string, shell: string): Promise<void> {
  await tmuxAgent(["new-session", "-d", "-s", name, shell]);

  // We use tmux only for persistence; keep the user experience "plain shell".
  // These options are per-session so we don't mutate other sessions.
  await tmuxAgent(["set-option", "-t", name, "status", "off"]);
  await tmuxAgent(["set-option", "-t", name, "mouse", "off"]);
  await tmuxAgent(["set-option", "-t", name, "prefix", "None"]);
  try {
    // Older tmux versions may not have prefix2; ignore.
    await tmuxAgent(["set-option", "-t", name, "prefix2", "None"]);
  } catch {
    // ignore
  }
}

export async function tmuxKillSession(name: string): Promise<void> {
  const server = await tmuxLocateSession(name);
  if (!server) return;
  if (server === "default") {
    await tmuxDefault(["kill-session", "-t", name]);
    return;
  }
  await tmuxAgent(["kill-session", "-t", name]);
}
