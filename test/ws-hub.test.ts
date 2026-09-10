import { describe, expect, test, vi } from "vitest";
import { WsHub } from "../src/ws/hub.js";

type FakeWs = {
  readyState: number;
  OPEN: number;
  bufferedAmount: number;
  sent: string[];
  send: (payload: string) => void;
  close: () => void;
  on: (event: string, fn: () => void) => void;
};

function fakeWs(): FakeWs {
  const ws: FakeWs = {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    sent: [],
    send(payload) {
      ws.sent.push(payload);
    },
    close() {
      ws.readyState = 3;
    },
    on() {},
  };
  return ws;
}

function outputs(ws: FakeWs): unknown[] {
  return ws.sent.map((s) => JSON.parse(s)).filter((m: any) => m.type === "pty_output");
}

describe("WsHub subscriptions", () => {
  test("output only reaches subscribed clients", async () => {
    vi.useFakeTimers();
    const hub = new WsHub();
    const ws = fakeWs();
    const client = hub.add(ws as never);

    hub.queuePtyOutput("pty_a", "before");
    hub.markSubscribed(client, "pty_a");
    hub.queuePtyOutput("pty_a", "after");
    await vi.advanceTimersByTimeAsync(50);

    expect(outputs(ws)).toEqual([{ type: "pty_output", ptyId: "pty_a", data: "after" }]);
    vi.useRealTimers();
  });

  test("unsubscribe stops the stream and drops queued output", async () => {
    vi.useFakeTimers();
    const hub = new WsHub();
    const ws = fakeWs();
    const client = hub.add(ws as never);
    hub.markSubscribed(client, "pty_a");

    hub.queuePtyOutput("pty_a", "queued");
    hub.markUnsubscribed(client, "pty_a");
    hub.queuePtyOutput("pty_a", "later");
    await vi.advanceTimersByTimeAsync(50);

    expect(outputs(ws)).toEqual([]);
    expect(hub.subscriberCounts()).toEqual({});
    vi.useRealTimers();
  });

  test("unsubscribing a pty leaves the other subscriptions alone", async () => {
    vi.useFakeTimers();
    const hub = new WsHub();
    const ws = fakeWs();
    const client = hub.add(ws as never);
    hub.markSubscribed(client, "pty_a");
    hub.markSubscribed(client, "pty_b");

    hub.markUnsubscribed(client, "pty_a");
    hub.queuePtyOutput("pty_a", "gone");
    hub.queuePtyOutput("pty_b", "kept");
    await vi.advanceTimersByTimeAsync(50);

    expect(outputs(ws)).toEqual([{ type: "pty_output", ptyId: "pty_b", data: "kept" }]);
    expect(hub.subscriberCounts()).toEqual({ pty_b: 1 });
    vi.useRealTimers();
  });

  test("unsubscribing twice is a no-op", () => {
    const hub = new WsHub();
    const ws = fakeWs();
    const client = hub.add(ws as never);
    const changes = vi.fn();
    hub.onSubscriberChange = changes;

    hub.markSubscribed(client, "pty_a");
    hub.markUnsubscribed(client, "pty_a");
    hub.markUnsubscribed(client, "pty_a");

    expect(changes).toHaveBeenCalledTimes(2);
  });
});
