import { describe, expect, it } from "vitest";
import { sendInputMessage } from "../src/mcp/send-input.js";

describe("send_input message", () => {
  it("submits plain text through mobile_submit", () => {
    expect(sendInputMessage("pty-1", "hello", true)).toEqual({ type: "mobile_submit", ptyId: "pty-1", body: "hello" });
  });

  it("does not treat a trailing newline as Enter", () => {
    expect(sendInputMessage("pty-1", "hello\n", true)).toEqual({ type: "mobile_submit", ptyId: "pty-1", body: "hello\n" });
    expect(sendInputMessage("pty-1", "\n", true)).toEqual({ type: "mobile_submit", ptyId: "pty-1", body: "\n" });
  });

  it("writes data that already ends with a carriage return as is", () => {
    expect(sendInputMessage("pty-1", "y\r", true)).toEqual({ type: "input", ptyId: "pty-1", data: "y\r" });
  });

  it("writes raw data when appendEnter is off", () => {
    expect(sendInputMessage("pty-1", "hello\n", false)).toEqual({ type: "input", ptyId: "pty-1", data: "hello\n" });
  });
});
