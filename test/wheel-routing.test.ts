import { describe, expect, test } from "vitest";
import { planWheelInput } from "../src/tmux.js";

const ESC = "\u001b";
const WHEEL_UP = `${ESC}[<64;1;1M`;
const WHEEL_DOWN = `${ESC}[<65;1;1M`;

const shell = { alternateOn: false, command: "zsh", mouseAny: false };
const claude = { alternateOn: true, command: "claude", mouseAny: false };
const vim = { alternateOn: true, command: "vim", mouseAny: false };
const vimMouse = { alternateOn: true, command: "vim", mouseAny: true };

describe("planWheelInput", () => {
  test("normal panes scroll tmux history", () => {
    expect(planWheelInput(shell, "up", 3)).toEqual({ kind: "history" });
    expect(planWheelInput({ ...shell, command: "claude" }, "up", 3)).toEqual({ kind: "history" });
  });

  test("Claude Code in the alternate screen gets one SGR wheel event per line", () => {
    expect(planWheelInput(claude, "up", 3)).toEqual({ kind: "literal", data: WHEEL_UP.repeat(3) });
    expect(planWheelInput(claude, "down", 1)).toEqual({ kind: "literal", data: WHEEL_DOWN });
  });

  test("apps that asked for the mouse get SGR wheel events too", () => {
    expect(planWheelInput(vimMouse, "down", 2)).toEqual({ kind: "literal", data: WHEEL_DOWN.repeat(2) });
  });

  test("other full-screen apps get arrow keys", () => {
    expect(planWheelInput(vim, "up", 4)).toEqual({ kind: "keys", key: "Up", count: 4 });
    expect(planWheelInput(vim, "down", 2)).toEqual({ kind: "keys", key: "Down", count: 2 });
  });

  test("clamps the line count", () => {
    expect(planWheelInput(vim, "up", 0)).toEqual({ kind: "keys", key: "Up", count: 1 });
    expect(planWheelInput(vim, "up", 999)).toEqual({ kind: "keys", key: "Up", count: 200 });
    expect(planWheelInput(claude, "up", 2.7)).toEqual({ kind: "literal", data: WHEEL_UP.repeat(2) });
  });
});
