import { EventEmitter } from "node:events";
import Fastify from "fastify";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { mobileSubmitBodyInput, registerWs } from "../src/server/ws.js";
import { WsHub } from "../src/ws/hub.js";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

describe("mobileSubmitBodyInput", () => {
  it("types short bodies as keys", () => {
    expect(mobileSubmitBodyInput("echo hi")).toBe("echo hi");
    expect(mobileSubmitBodyInput("x".repeat(512))).toBe("x".repeat(512));
  });

  it("sends long bodies as one bracketed paste", () => {
    const body = "x".repeat(513);
    expect(mobileSubmitBodyInput(body)).toBe(`${PASTE_START}${body}${PASTE_END}`);
  });

  it("sends multi-line bodies as a paste so each line does not submit", () => {
    expect(mobileSubmitBodyInput("one\ntwo")).toBe(`${PASTE_START}one\ntwo${PASTE_END}`);
  });

  it("measures the limit in bytes", () => {
    const body = "é".repeat(300);
    expect(mobileSubmitBodyInput(body)).toBe(`${PASTE_START}${body}${PASTE_END}`);
  });

  it("keeps an embedded end marker from closing the paste early", () => {
    const body = `${"x".repeat(600)}${PASTE_END}\r`;
    expect(mobileSubmitBodyInput(body)).toBe(`${PASTE_START}${"x".repeat(600)}[201~\r${PASTE_END}`);
  });
});

describe("mobile_submit over ws", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  async function submit(body: string): Promise<string[]> {
    const fastify = Fastify();
    const writes: string[] = [];
    const ptys = Object.assign(new EventEmitter(), {
      list: () => [],
      getSummary: () => null,
      resize: () => {},
      write: (_id: string, data: string) => {
        writes.push(data);
        // Echo like a shell so the Enter gate opens without waiting for its timeout.
        if (data !== "\r") setImmediate(() => ptys.emit("output", "pty-1", data));
      },
    });
    registerWs({
      fastify,
      hub: new WsHub(),
      ptys: ptys as any,
      readinessEngine: { markInput: () => {} } as any,
      listPtys: async () => [],
      inputAnchors: {} as any,
    });
    await fastify.listen({ host: "127.0.0.1", port: 0 });
    const address = fastify.server.address();
    if (!address || typeof address === "string") throw new Error("unexpected address");
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    cleanup = async () => {
      ws.close();
      await fastify.close();
    };
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    ws.send(JSON.stringify({ type: "mobile_submit", ptyId: "pty-1", body }));
    const deadline = Date.now() + 3000;
    while (!writes.includes("\r") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return writes;
  }

  it("writes a short body and then Enter", async () => {
    expect(await submit("echo hi")).toEqual(["echo hi", "\r"]);
  });

  it("drops outer line breaks from a single-line body", async () => {
    expect(await submit("echo hi\n")).toEqual(["echo hi", "\r"]);
  });

  it("drops a trailing carriage return so Enter is only sent after the gate", async () => {
    expect(await submit("echo hi\r")).toEqual(["echo hi", "\r"]);
  });

  it("keeps inner line breaks inside the paste", async () => {
    expect(await submit("\nline one\r\nline two\r\n")).toEqual([`${PASTE_START}line one\nline two${PASTE_END}`, "\r"]);
  });

  it("writes a long body as a paste and Enter as its own write", async () => {
    const body = "word ".repeat(500).trim();
    expect(await submit(body)).toEqual([`${PASTE_START}${body}${PASTE_END}`, "\r"]);
  });
});
