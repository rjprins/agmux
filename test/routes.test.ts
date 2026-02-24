import Fastify from "fastify";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import { registerAgentRoutes } from "../src/server/routes/agents.js";
import { registerPtyRoutes } from "../src/server/routes/ptys.js";
import { registerWorktreeRoutes } from "../src/server/routes/worktrees.js";
import { registerWs } from "../src/server/ws.js";
import { WsHub } from "../src/ws/hub.js";

describe("route wiring", () => {
  it("serves /api/ptys with runtime list", async () => {
    const fastify = Fastify();
    const runtime = {
      ptys: { spawn: () => {}, list: () => [], getSummary: () => null, kill: () => {}, write: () => {}, resize: () => {} },
      readinessEngine: { markExited: () => {} },
      listPtys: async () => [
        { id: "pty-1", name: "shell", backend: "tmux", command: "tmux", args: [], cwd: null, createdAt: 0, status: "running" },
      ],
      broadcastPtyList: async () => {},
      trackLinkedSession: () => {},
      getReadinessTrace: () => [],
    } as any;
    const store = {
      upsertSession: () => {},
      getPreference: () => ({}),
      setPreference: () => {},
      loadAllInputHistory: () => ({}),
      saveInputHistory: () => {},
    } as any;
    const worktrees = {
      resolveProjectRoot: async () => null,
      createWorktreeFromBase: async () => "",
      directoryExists: async () => true,
      isKnownWorktreePath: () => true,
    } as any;

    registerPtyRoutes({
      fastify,
      store,
      runtime,
      worktrees,
      defaultBaseBranch: "main",
      agmuxSession: "agmux",
    });

    const res = await fastify.inject({ method: "GET", url: "/api/ptys" });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { ptys: Array<{ id: string }> };
    expect(json.ptys).toHaveLength(1);
    expect(json.ptys[0]?.id).toBe("pty-1");
    await fastify.close();
  });

  it("serves /api/agent-sessions with merged list", async () => {
    const fastify = Fastify();
    const agentSessions = {
      listAgentSessions: () => [
        {
          id: "agent:claude:1",
          provider: "claude",
          providerSessionId: "1",
          name: "claude:proj",
          command: "claude",
          args: ["--resume", "1"],
          cwd: "/tmp",
          cwdSource: "log",
          projectRoot: "/tmp",
          worktree: null,
          createdAt: 0,
          lastSeenAt: 1,
          lastRestoredAt: null,
        },
      ],
      findAgentSessionSummary: () => null,
      upsertAgentSessionSummary: () => {},
      persistRuntimeCwdForAgentPty: () => {},
      attachPtyToAgentSession: () => {},
      detachPty: () => {},
    } as any;
    const runtime = {
      ptys: { spawn: () => {}, list: () => [], write: () => {} },
      broadcastPtyList: async () => {},
      trackLinkedSession: () => {},
    } as any;
    const store = { upsertSession: () => {} } as any;
    const worktrees = { isKnownWorktreePath: () => true, createWorktreeFromHead: async () => "" } as any;

    registerAgentRoutes({
      fastify,
      store,
      agentSessions,
      worktrees,
      runtime,
      repoRoot: "/tmp",
      agmuxSession: "agmux",
    });

    const res = await fastify.inject({ method: "GET", url: "/api/agent-sessions" });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { sessions: Array<{ id: string }> };
    expect(json.sessions).toHaveLength(1);
    expect(json.sessions[0]?.id).toBe("agent:claude:1");
    await fastify.close();
  });

  it("serves /api/worktrees with cached list", async () => {
    const fastify = Fastify();
    const worktrees = {
      listWorktrees: () => ({ worktrees: [{ name: "wt", path: "/tmp/wt", branch: "wt" }], repoRoot: "/tmp" }),
      defaultBranch: async () => "main",
      resolveProjectRoot: async () => null,
      worktreeStatus: async () => ({ dirty: false, branch: "wt" }),
      removeWorktree: async () => {},
      directoryExists: async () => true,
      isKnownWorktreePath: () => true,
    } as any;

    registerWorktreeRoutes({ fastify, worktrees });

    const res = await fastify.inject({ method: "GET", url: "/api/worktrees" });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { worktrees: Array<{ name: string }> };
    expect(json.worktrees).toHaveLength(1);
    expect(json.worktrees[0]?.name).toBe("wt");
    await fastify.close();
  });
});

describe("ws wiring", () => {
  it("emits pty_list on connect", async () => {
    const fastify = Fastify();
    const hub = new WsHub();
    const sample = {
      id: "pty-1",
      name: "shell",
      backend: "tmux",
      command: "tmux",
      args: [],
      cwd: null,
      createdAt: 0,
      status: "running",
    };
    const ptys = {
      list: () => [sample],
      getSummary: (id: string) => (id === "pty-1" ? sample : null),
      write: () => {},
      resize: () => {},
    } as any;
    const readinessEngine = { markInput: () => {} } as any;
    registerWs({
      fastify,
      hub,
      ptys,
      readinessEngine,
      listPtys: async () => [sample],
    });

    await fastify.listen({ host: "127.0.0.1", port: 0 });
    const address = fastify.server.address();
    if (!address || typeof address === "string") {
      throw new Error("unexpected address");
    }
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);

    const msg = await new Promise<any>((resolve, reject) => {
      ws.on("message", (data) => {
        try {
          resolve(JSON.parse(String(data)));
        } catch (err) {
          reject(err);
        }
      });
      ws.on("error", (err) => reject(err));
    });

    expect(msg.type).toBe("pty_list");
    expect(msg.ptys?.[0]?.id).toBe("pty-1");

    ws.close();
    await fastify.close();
  });
});
