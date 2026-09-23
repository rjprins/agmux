import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_PATH_LENGTH = 1024;

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function expandHome(raw: string, home: string): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return path.join(home, raw.slice(2));
  return raw;
}

/**
 * Resolve a path seen in terminal output to an existing regular file.
 * Relative paths are tried against each base dir in order (the pane's cwd,
 * then its git root, where agents usually print paths from).
 */
export async function resolveTerminalFilePath(
  raw: string,
  baseDirs: string[],
  home: string = os.homedir(),
): Promise<string | null> {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_PATH_LENGTH || trimmed.includes("\0")) return null;

  const expanded = expandHome(trimmed, home);
  if (path.isAbsolute(expanded)) {
    return (await isRegularFile(expanded)) ? path.resolve(expanded) : null;
  }

  // `git diff` prints a/<path> and b/<path>.
  const variants = [expanded];
  const diffPrefix = /^[ab]\/(.+)$/.exec(expanded);
  if (diffPrefix) variants.push(diffPrefix[1]);

  for (const variant of variants) {
    for (const base of baseDirs) {
      const candidate = path.resolve(base, variant);
      if (await isRegularFile(candidate)) return candidate;
    }
  }
  return null;
}
