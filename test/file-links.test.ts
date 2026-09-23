import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { buildOpenFileEval } from "../src/server/emacs.js";
import { resolveTerminalFilePath } from "../src/server/file-links.js";
import { bufferLineText, findFileLinkCandidates } from "../src/ui/file-links.js";

function pick(text: string) {
  return findFileLinkCandidates(text).map((c) => ({
    text: text.slice(c.start, c.end),
    path: c.path,
    line: c.line,
    column: c.column,
  }));
}

describe("findFileLinkCandidates", () => {
  test("finds relative paths with line and column", () => {
    expect(pick("error at src/ui/app.ts:1197:3 here")).toEqual([
      { text: "src/ui/app.ts:1197:3", path: "src/ui/app.ts", line: 1197, column: 3 },
    ]);
  });

  test("finds absolute, home and dot-relative paths", () => {
    expect(pick("/etc/hosts ~/notes/todo.md ./run.sh ../x/y").map((c) => c.path)).toEqual([
      "/etc/hosts",
      "~/notes/todo.md",
      "./run.sh",
      "../x/y",
    ]);
  });

  test("finds bare file names with an extension", () => {
    expect(pick("modified: package.json").map((c) => c.path)).toEqual(["package.json"]);
  });

  test("reads tsc-style (line,col) suffixes", () => {
    expect(pick("src/a.ts(12,5): error TS1")).toEqual([
      { text: "src/a.ts(12,5)", path: "src/a.ts", line: 12, column: 5 },
    ]);
  });

  test("reads Python traceback line numbers", () => {
    expect(pick('  File "app/main.py", line 42, in run')).toEqual([
      { text: "app/main.py", path: "app/main.py", line: 42, column: undefined },
    ]);
  });

  test("drops a trailing sentence dot", () => {
    expect(pick("See docs/setup.md.")).toEqual([
      { text: "docs/setup.md", path: "docs/setup.md", line: undefined, column: undefined },
    ]);
  });

  test("finds paths inside parentheses and backticks", () => {
    expect(pick("Update(src/tmux.ts) and `test/ws.test.ts`").map((c) => c.path)).toEqual([
      "src/tmux.ts",
      "test/ws.test.ts",
    ]);
  });

  test("ignores URLs, plain words and version numbers", () => {
    expect(pick("see https://example.com/a/b.html for v1.2.3 and words")).toEqual([]);
  });
});

describe("bufferLineText", () => {
  test("maps string offsets to cells across wide characters", () => {
    // "界" takes two cells; the second cell has width 0.
    const cells = [
      { chars: "界", width: 2 },
      { chars: "", width: 0 },
      { chars: "a", width: 1 },
    ];
    const line = {
      length: cells.length,
      getCell: (x: number) => ({ getChars: () => cells[x].chars, getWidth: () => cells[x].width }),
    } as any;

    expect(bufferLineText(line)).toEqual({ text: "界a", cellOf: [0, 2, 3] });
  });
});

describe("resolveTerminalFilePath", () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-file-links-"));
    fs.mkdirSync(path.join(root, "repo", "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "repo", "src", "a.ts"), "");
    fs.mkdirSync(path.join(root, "home", "notes"), { recursive: true });
    fs.writeFileSync(path.join(root, "home", "notes", "todo.md"), "");
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("resolves against the cwd first, then the git root", async () => {
    const repo = path.join(root, "repo");
    const nested = path.join(repo, "src");
    expect(await resolveTerminalFilePath("a.ts", [nested, repo])).toBe(path.join(nested, "a.ts"));
    expect(await resolveTerminalFilePath("src/a.ts", [nested, repo])).toBe(path.join(nested, "a.ts"));
  });

  test("strips git diff a/ and b/ prefixes", async () => {
    const repo = path.join(root, "repo");
    expect(await resolveTerminalFilePath("b/src/a.ts", [repo])).toBe(path.join(repo, "src", "a.ts"));
  });

  test("expands ~ and accepts absolute paths", async () => {
    const home = path.join(root, "home");
    expect(await resolveTerminalFilePath("~/notes/todo.md", [], home)).toBe(path.join(home, "notes", "todo.md"));
    const abs = path.join(root, "repo", "src", "a.ts");
    expect(await resolveTerminalFilePath(abs, [])).toBe(abs);
  });

  test("rejects directories and missing files", async () => {
    const repo = path.join(root, "repo");
    expect(await resolveTerminalFilePath("src", [repo])).toBeNull();
    expect(await resolveTerminalFilePath("src/missing.ts", [repo])).toBeNull();
  });
});

describe("buildOpenFileEval", () => {
  test("visits the file at the given line and column in a raised frame", () => {
    const form = buildOpenFileEval("/repo/src/a \"b\".ts", { line: 12, column: 5 });

    expect(form).toContain('(find-file "/repo/src/a \\"b\\".ts")');
    expect(form).toContain("(forward-line 11)");
    expect(form).toContain("(move-to-column 4)");
    expect(form).toContain("(raise-frame frame)");
  });

  test("leaves point alone without a line", () => {
    const form = buildOpenFileEval("/repo/a.ts");

    expect(form).not.toContain("forward-line");
    expect(form).not.toContain("move-to-column");
  });
});
