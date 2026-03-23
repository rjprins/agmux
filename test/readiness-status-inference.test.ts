import { describe, expect, it } from "vitest";
import { inferPaneStatus, type PaneCacheState, type PaneSnapshot } from "../src/readiness/status-inference.js";

const GRACE_MS = 4000;

function run(
  prev: PaneCacheState | undefined,
  next: PaneSnapshot,
  now: number,
) {
  return inferPaneStatus({
    prev,
    next,
    now,
    workingGracePeriodMs: GRACE_MS,
  });
}

describe("readiness status inference", () => {
  it("starts in waiting when first snapshot has no permission prompt", () => {
    const result = run(undefined, { content: "hello", width: 120, height: 40 }, 1000);
    expect(result.status).toBe("waiting");
    expect(result.nextCheckInMs).toBeNull();
  });

  it("reports working when content changes", () => {
    const prev = run(undefined, { content: "hello", width: 120, height: 40 }, 1000).nextCache;
    const result = run(prev, { content: "hello world", width: 120, height: 40 }, 2000);
    expect(result.status).toBe("working");
    expect(result.nextCheckInMs).toBeGreaterThan(0);
  });

  it("reports permission when prompt is visible and content is stable", () => {
    const permission = "Do you want to proceed?\n1. Yes\n2. No";
    const first = run(undefined, { content: permission, width: 120, height: 40 }, 1000);
    const second = run(first.nextCache, { content: permission, width: 120, height: 40 }, 8000);
    expect(second.status).toBe("permission");
  });

  it("stays working during grace period after a change", () => {
    const first = run(undefined, { content: "a", width: 120, height: 40 }, 1000);
    const changed = run(first.nextCache, { content: "b", width: 120, height: 40 }, 2000);
    const withinGrace = run(changed.nextCache, { content: "b", width: 120, height: 40 }, 2000 + GRACE_MS - 50);
    expect(withinGrace.status).toBe("working");
    expect(withinGrace.nextCheckInMs).toBeGreaterThan(0);
  });

  it("returns waiting after grace period expires", () => {
    const first = run(undefined, { content: "a", width: 120, height: 40 }, 1000);
    const changed = run(first.nextCache, { content: "b", width: 120, height: 40 }, 2000);
    const afterGrace = run(changed.nextCache, { content: "b", width: 120, height: 40 }, 2000 + GRACE_MS + 5);
    expect(afterGrace.status).toBe("waiting");
    expect(afterGrace.nextCheckInMs).toBeNull();
  });

  it("ignores metadata-only resize changes", () => {
    const first = run(
      undefined,
      { content: "Output line\n89% context left · ? for shortcuts", width: 120, height: 40 },
      1000,
    );
    const second = run(
      first.nextCache,
      { content: "Output line\n88% context left · ? for shortcuts", width: 80, height: 24 },
      5000,
    );
    expect(second.status).toBe("waiting");
  });
});
