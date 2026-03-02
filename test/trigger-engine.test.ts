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

  it("passes control hooks to trigger context", async () => {
    const eng = new TriggerEngine();
    const writes: Array<{ ptyId: string; data: string }> = [];
    const writeToCalls: Array<{ ptyId: string; data: string }> = [];
    let spawnCount = 0;
    let listCount = 0;

    eng.setTriggers([
      {
        name: "hooks",
        pattern: /go/,
        onMatch: async (ctx) => {
          ctx.write("self\n");
          ctx.hooks.writeTo("pty_worker", "other\n");
          ctx.hooks.listPtys();
          await ctx.hooks.spawnShell({ name: "worker" });
        },
      } as any,
    ]);

    eng.onOutput(
      "pty_1",
      "go\n",
      () => {},
      (ptyId, data) => writes.push({ ptyId, data }),
      {
        writeTo: (ptyId, data) => writeToCalls.push({ ptyId, data }),
        listPtys: () => {
          listCount += 1;
          return [];
        },
        spawnShell: async () => {
          spawnCount += 1;
          return { ptyId: "pty_worker", cwd: null, tmuxSession: "agmux:@2" };
        },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toEqual([{ ptyId: "pty_1", data: "self\n" }]);
    expect(writeToCalls).toEqual([{ ptyId: "pty_worker", data: "other\n" }]);
    expect(listCount).toBe(1);
    expect(spawnCount).toBe(1);
  });

  it("emits trigger_error for async trigger failures", async () => {
    const eng = new TriggerEngine();
    const fired: any[] = [];
    eng.setTriggers([
      {
        name: "async_fail",
        pattern: /boom/,
        onMatch: async () => {
          throw new Error("boom");
        },
      } as any,
    ]);

    eng.onOutput("pty_1", "boom\n", (evt) => fired.push(evt), () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fired).toEqual([
      expect.objectContaining({
        type: "trigger_error",
        ptyId: "pty_1",
        trigger: "async_fail",
        message: "boom",
      }),
    ]);
  });
});
