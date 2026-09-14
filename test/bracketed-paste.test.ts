import { describe, expect, it } from "vitest";
import { bracketedPaste } from "../src/shared/bracketed-paste.js";

describe("bracketedPaste", () => {
  it("wraps text in paste markers", () => {
    expect(bracketedPaste("line one\nline two")).toBe("\x1b[200~line one\nline two\x1b[201~");
  });

  it("removes ESC so embedded markers cannot end the paste early", () => {
    expect(bracketedPaste("a\x1b[201~\rb\x1b[200~c\x1b[Z")).toBe("\x1b[200~a[201~\rb[200~c[Z\x1b[201~");
  });
});
