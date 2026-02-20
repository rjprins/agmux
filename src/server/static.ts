import fs from "node:fs/promises";
import path from "node:path";

export type StaticResponse = { data: Buffer; type: string; etag: string; lastModified: string };

export async function serveStatic(publicDir: string, rel: string): Promise<StaticResponse | null> {
  const safe = path.normalize(rel).replace(/^(\\.\\.[/\\\\])+/, "");
  const filePath = path.join(publicDir, safe);
  if (!filePath.startsWith(publicDir)) return null;
  let st: Awaited<ReturnType<typeof fs.stat>>;
  try {
    st = await fs.stat(filePath);
    if (!st.isFile()) return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
  let data: Buffer;
  try {
    data = await fs.readFile(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return null;
    throw err;
  }
  const ext = path.extname(filePath).toLowerCase();
  const type =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".css"
        ? "text/css; charset=utf-8"
        : ext === ".js"
          ? "text/javascript; charset=utf-8"
          : ext === ".map"
            ? "application/json; charset=utf-8"
            : "application/octet-stream";
  const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
  const lastModified = st.mtime.toUTCString();
  return { data, type, etag, lastModified };
}
