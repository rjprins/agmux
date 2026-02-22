import type { FastifyInstance } from "fastify";
import {
  tmuxCheckSessionConfig,
  tmuxIsLinkedViewSession,
  tmuxListSessions,
  tmuxLocateSession,
  type TmuxServer,
} from "../../tmux.js";

type TmuxRoutesDeps = {
  fastify: FastifyInstance;
};

export function registerTmuxRoutes(deps: TmuxRoutesDeps): void {
  const { fastify } = deps;

  fastify.get("/api/tmux/sessions", async () => {
    const sessions = (await tmuxListSessions()).filter((s) => !tmuxIsLinkedViewSession(s.name));
    return { sessions };
  });

  fastify.get("/api/tmux/check", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const name = typeof q.name === "string" ? q.name.trim() : "";
    const serverRaw = typeof q.server === "string" ? q.server : "";
    if (!name) {
      reply.code(400);
      return { error: "name is required" };
    }
    if (serverRaw !== "agmux" && serverRaw !== "default") {
      reply.code(400);
      return { error: "server must be agmux or default" };
    }
    const requestedServer: TmuxServer = serverRaw;
    const located = await tmuxLocateSession(name, requestedServer);
    if (located !== requestedServer) {
      reply.code(404);
      return { error: "tmux session not found on requested server" };
    }
    const checks = await tmuxCheckSessionConfig(name, requestedServer);
    return { checks };
  });
}
