import type { FastifyInstance } from "fastify";

type TriggerRoutesDeps = {
  fastify: FastifyInstance;
  loadTriggersAndBroadcast: (reason: string) => Promise<void>;
};

export function registerTriggerRoutes(deps: TriggerRoutesDeps): void {
  const { fastify, loadTriggersAndBroadcast } = deps;

  fastify.post("/api/triggers/reload", async () => {
    await loadTriggersAndBroadcast("manual");
    return { ok: true };
  });
}
