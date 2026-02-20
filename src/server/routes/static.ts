import type { FastifyInstance } from "fastify";
import { serveStatic } from "../static.js";

type StaticRoutesDeps = {
  fastify: FastifyInstance;
  publicDir: string;
};

export function registerStaticRoutes(deps: StaticRoutesDeps): void {
  const { fastify, publicDir } = deps;

  fastify.get("/", async (_req, reply) => {
    const r = await serveStatic(publicDir, "index.html");
    if (!r) return reply.code(404).send("not found");
    reply.header("Cache-Control", "no-store");
    reply.header("ETag", r.etag);
    reply.header("Last-Modified", r.lastModified);
    return reply.type(r.type).send(r.data);
  });

  fastify.get("/:file", async (req, reply) => {
    const file = (req.params as any).file as string;
    if (file.startsWith("api")) return reply.code(404).send("not found");
    const r = await serveStatic(publicDir, file);
    if (!r) return reply.code(404).send("not found");

    reply.header("Cache-Control", "no-store");
    reply.header("ETag", r.etag);
    reply.header("Last-Modified", r.lastModified);

    const inm = req.headers["if-none-match"];
    if (typeof inm === "string" && inm === r.etag) return reply.code(304).send();

    return reply.type(r.type).send(r.data);
  });
}
