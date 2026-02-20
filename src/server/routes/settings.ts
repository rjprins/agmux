import type { FastifyInstance } from "fastify";
import type { SqliteStore } from "../../persist/sqlite.js";
import { parseJsonBody } from "../auth.js";

type SettingsRoutesDeps = {
  fastify: FastifyInstance;
  store: SqliteStore;
};

export function registerSettingsRoutes(deps: SettingsRoutesDeps): void {
  const { fastify, store } = deps;

  fastify.get("/api/launch-preferences", async () => {
    return store.getPreference("launch") ?? {};
  });

  fastify.get("/api/settings", async () => {
    return store.getPreference("settings") ?? {};
  });

  fastify.put("/api/settings", async (req) => {
    const body = parseJsonBody(req.body);
    const prev = store.getPreference<Record<string, unknown>>("settings") ?? {};
    const merged = { ...prev, ...body };
    for (const [k, v] of Object.entries(merged)) {
      if (v === null) delete merged[k];
    }
    store.setPreference("settings", merged);
    return merged;
  });
}
