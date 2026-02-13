import { describe, expect, it } from "vitest";
import { TriggerEngine } from "../src/triggers/engine.js";

describe("TriggerEngine", () => {
  it("fires a line trigger on matching line", () => {
    const eng = new TriggerEngine();
    const fired: any[] = [];

    eng.setTriggers([
      {
        name: "t1",
        pattern: /proceed \(y\)\?/i,
        scope: "line",
        onMatch: (ctx) => ctx.emit({ type: "trigger_fired", ptyId: ctx.ptyId, name: "t1" }),
      } as any,
    ]);

    eng.onOutput(
      "pty_1",
      "hello\nproceed (y)?\n",
      (evt) => fired.push(evt),
      () => {},
    );

    expect(fired.some((e) => e.type === "trigger_fired")).toBe(true);
  });

  it("respects cooldown", () => {
    const eng = new TriggerEngine();
    let count = 0;
    eng.setTriggers([
      {
        name: "t1",
        pattern: /x/,
        cooldownMs: 60_000,
        onMatch: () => {
          count++;
        },
      } as any,
    ]);

    eng.onOutput("pty_1", "x\n", () => {}, () => {});
    eng.onOutput("pty_1", "x\n", () => {}, () => {});
    expect(count).toBe(1);
  });
});

