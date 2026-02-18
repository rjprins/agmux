import { describe, expect, test } from "vitest";
import { mergePtyLists } from "../src/sessionList.js";
import type { PtySummary } from "../src/types.js";

function makeSummary(overrides: Partial<PtySummary> = {}): PtySummary {
  return {
    id: "pty-1",
    name: "shell:bash",
    command: "bash",
    args: [],
    cwd: "/tmp",
    createdAt: 1_000,
    status: "running",
    ...overrides,
  };
}

describe("mergePtyLists", () => {
  test("keeps live sessions and appends persisted inactive sessions", () => {
    const live = [makeSummary({ id: "live-1", status: "running", createdAt: 5_000 })];
    const persisted = [
      makeSummary({ id: "live-1", status: "exited", createdAt: 4_000, lastSeenAt: 4_100 }),
      makeSummary({ id: "inactive-1", status: "exited", createdAt: 3_000, lastSeenAt: 6_000 }),
    ];

    const merged = mergePtyLists(live, persisted, { nowMs: 8_000, inactiveMaxAgeHours: 24 });

    expect(merged.map((s) => s.id)).toEqual(["inactive-1", "live-1"]);
    expect(merged.find((s) => s.id === "live-1")?.status).toBe("running");
  });

  test("converts persisted stale running sessions to exited", () => {
    const merged = mergePtyLists(
      [],
      [makeSummary({ id: "stale-running", status: "running", lastSeenAt: 10_000 })],
      { nowMs: 20_000, inactiveMaxAgeHours: 24 },
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.status).toBe("exited");
  });

  test("filters out inactive sessions older than max age", () => {
    const nowMs = 30 * 60 * 60 * 1000; // hour 30
    const recent = makeSummary({
      id: "recent",
      status: "exited",
      createdAt: nowMs - 2 * 60 * 60 * 1000,
      lastSeenAt: nowMs - 2 * 60 * 60 * 1000,
    });
    const old = makeSummary({
      id: "old",
      status: "exited",
      createdAt: nowMs - 28 * 60 * 60 * 1000,
      lastSeenAt: nowMs - 28 * 60 * 60 * 1000,
    });

    const merged = mergePtyLists([], [recent, old], { nowMs, inactiveMaxAgeHours: 24 });

    expect(merged.map((s) => s.id)).toEqual(["recent"]);
  });

  test("filters old exited live sessions but always keeps live running sessions", () => {
    const nowMs = 100 * 60 * 60 * 1000;
    const live = [
      makeSummary({
        id: "old-live-exited",
        status: "exited",
        createdAt: nowMs - 40 * 60 * 60 * 1000,
        lastSeenAt: nowMs - 40 * 60 * 60 * 1000,
      }),
      makeSummary({
        id: "live-running",
        status: "running",
        createdAt: nowMs - 80 * 60 * 60 * 1000,
        lastSeenAt: nowMs - 80 * 60 * 60 * 1000,
      }),
    ];

    const merged = mergePtyLists(live, [], { nowMs, inactiveMaxAgeHours: 24 });
    expect(merged.map((s) => s.id)).toEqual(["live-running"]);
  });
});
