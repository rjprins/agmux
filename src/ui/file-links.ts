import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";

export type FileLinkCandidate = {
  /** String offsets into the scanned text, end exclusive. */
  start: number;
  end: number;
  path: string;
  line?: number;
  column?: number;
};

// A path-like token, optionally followed by :line[:col] or (line[,col]).
// The lookbehind keeps us from starting inside a word or a URL.
const CANDIDATE_RE =
  /(?<![\w./~@+:-])((?:~|\.{1,2})?\/?[\w@+-][\w./@+-]*)(?::(\d+)(?::(\d+))?|\((\d+)(?:, ?(\d+))?\))?/g;
const EXTENSION_RE = /\.[A-Za-z][\w-]{0,9}$/;
const PYTHON_LINE_RE = /^", line (\d+)/;
const MAX_PATH_LENGTH = 1024;
const MAX_CANDIDATES_PER_LINE = 40;

function positiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export function findFileLinkCandidates(text: string): FileLinkCandidate[] {
  const out: FileLinkCandidate[] = [];
  for (const match of text.matchAll(CANDIDATE_RE)) {
    if (out.length >= MAX_CANDIDATES_PER_LINE) break;
    const start = match.index ?? 0;
    const rawPath = match[1];
    // A sentence-ending dot is punctuation, not part of the file name.
    const filePath = rawPath.replace(/\.+$/, "");
    if (!filePath || filePath.length > MAX_PATH_LENGTH) continue;
    if (!filePath.includes("/") && !EXTENSION_RE.test(filePath)) continue;
    if (/^\/+$/.test(filePath)) continue;

    const hasSuffix = filePath === rawPath && match[0].length > rawPath.length;
    let line = hasSuffix ? positiveInt(match[2] ?? match[4]) : undefined;
    const column = hasSuffix ? positiveInt(match[3] ?? match[5]) : undefined;
    const end = hasSuffix ? start + match[0].length : start + filePath.length;

    if (line === undefined && text[start - 1] === '"') {
      const py = PYTHON_LINE_RE.exec(text.slice(end));
      if (py) line = positiveInt(py[1]);
    }

    out.push({ start, end, path: filePath, line, column });
  }
  return out;
}

export type BufferLineText = {
  text: string;
  /** 0-based cell of each UTF-16 unit in `text`, plus a trailing end sentinel. */
  cellOf: number[];
};

// Wide characters take two cells but one string slot, so string offsets have
// to be mapped back to cells before xterm can draw a link.
export function bufferLineText(line: IBufferLine): BufferLineText {
  let text = "";
  const cellOf: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const chars = cell.getChars() || " ";
    for (let i = 0; i < chars.length; i++) cellOf.push(x);
    text += chars;
  }
  cellOf.push(line.length);
  return { text, cellOf };
}

export type ResolvedFileLinks = Record<string, string | null>;

export type FileLinkProviderDeps = {
  resolve: (paths: string[]) => Promise<ResolvedFileLinks>;
  open: (target: { path: string; line?: number; column?: number }) => void;
};

const RESOLVE_CACHE_TTL_MS = 10_000;

export function createFileLinkProvider(term: Terminal, deps: FileLinkProviderDeps): ILinkProvider {
  // Hovering re-queries a line on every move between rows, so remember answers briefly.
  const cache = new Map<string, { at: number; resolved: string | null }>();

  async function resolveAll(paths: string[]): Promise<Map<string, string | null>> {
    const now = Date.now();
    const result = new Map<string, string | null>();
    const missing: string[] = [];
    for (const p of paths) {
      const hit = cache.get(p);
      if (hit && now - hit.at < RESOLVE_CACHE_TTL_MS) result.set(p, hit.resolved);
      else missing.push(p);
    }
    if (missing.length > 0) {
      const fresh = await deps.resolve(missing);
      for (const p of missing) {
        const resolved = fresh[p] ?? null;
        cache.set(p, { at: now, resolved });
        result.set(p, resolved);
      }
    }
    return result;
  }

  return {
    provideLinks(bufferLineNumber, callback) {
      const bufferLine = term.buffer.active.getLine(bufferLineNumber - 1);
      if (!bufferLine) {
        callback(undefined);
        return;
      }
      const { text, cellOf } = bufferLineText(bufferLine);
      const candidates = findFileLinkCandidates(text);
      if (candidates.length === 0) {
        callback(undefined);
        return;
      }
      const uniquePaths = [...new Set(candidates.map((c) => c.path))];
      resolveAll(uniquePaths)
        .then((resolved) => {
          const links: ILink[] = [];
          for (const c of candidates) {
            if (!resolved.get(c.path)) continue;
            links.push({
              range: {
                start: { x: cellOf[c.start] + 1, y: bufferLineNumber },
                end: { x: cellOf[c.end], y: bufferLineNumber },
              },
              text: text.slice(c.start, c.end),
              activate: () => deps.open({ path: c.path, line: c.line, column: c.column }),
            });
          }
          callback(links.length > 0 ? links : undefined);
        })
        .catch(() => callback(undefined));
    },
  };
}
