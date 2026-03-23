import { describe, expect, test } from "vitest";
import type { PtySummary } from "../src/shared/protocol.js";
import { compareSidebarGroupKeys, orderRunningPtysForSidebar } from "../src/ui/pty-order.js";

function pty(id: string, cwd: string | null, createdAt: number, status: "running" | "exited" = "running"): PtySummary {
  return {
    id,
    name: `pty-${id}`,
    backend: "tmux",
    command: "bash",
    args: [],
    cwd,
    createdAt,
    status,
  };
}

describe("compareSidebarGroupKeys", () => {
  test("sorts by basename and keeps empty keys last", () => {
    expect([...["", "/tmp/zeta", "/tmp/alpha"]].sort(compareSidebarGroupKeys)).toEqual([
      "/tmp/alpha",
      "/tmp/zeta",
      "",
    ]);
  });
});

describe("orderRunningPtysForSidebar", () => {
  test("orders running PTYs by pinned groups first, then sidebar group order", () => {
    const ptys = [
      pty("z-2", "/repos/zeta", 40),
      pty("a-2", "/repos/alpha", 30),
      pty("z-1", "/repos/zeta", 20),
      pty("b-1", "/repos/beta", 10),
    ];

    const ordered = orderRunningPtysForSidebar(ptys, {
      pinnedDirectories: new Set(["/repos/zeta"]),
      getGroupKey: (item) => item.cwd ?? "",
    });

    expect(ordered.map((item) => item.id)).toEqual(["z-2", "z-1", "a-2", "b-1"]);
  });

  test("ignores exited PTYs", () => {
    const ptys = [
      pty("beta", "/repos/beta", 20),
      pty("alpha-exited", "/repos/alpha", 15, "exited"),
      pty("alpha", "/repos/alpha", 10),
    ];

    const ordered = orderRunningPtysForSidebar(ptys, {
      pinnedDirectories: new Set<string>(),
      getGroupKey: (item) => item.cwd ?? "",
    });

    expect(ordered.map((item) => item.id)).toEqual(["alpha", "beta"]);
  });
});
