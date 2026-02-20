import fs from "node:fs/promises";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function pathExistsAndIsDirectory(target: string): Promise<boolean> {
  try {
    const st = await fs.stat(target);
    return st.isDirectory();
  } catch {
    return false;
  }
}
