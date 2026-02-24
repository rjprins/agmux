import type { FastifyInstance } from "fastify";
import type { SqliteStore } from "../../persist/sqlite.js";
import type { TaskFilter, TaskInput, TaskPriority, TaskStatus, TaskUpdate } from "../../tasks/types.js";
import { parseJsonBody } from "../auth.js";
import { getTaskProvider } from "../../tasks/registry.js";

type TaskRoutesDeps = {
  fastify: FastifyInstance;
  store: SqliteStore;
};

function requireProvider(store: SqliteStore) {
  const provider = getTaskProvider(store);
  if (!provider) throw { statusCode: 404, message: "no task provider configured" };
  return provider;
}

export function registerTaskRoutes(deps: TaskRoutesDeps): void {
  const { fastify, store } = deps;

  // GET /api/tasks/provider — current provider info (or null)
  fastify.get("/api/tasks/provider", async () => {
    const provider = getTaskProvider(store);
    if (!provider) return { configured: false };
    return { configured: true, name: provider.name, capabilities: provider.capabilities };
  });

  // GET /api/tasks — list tasks with optional filters
  fastify.get("/api/tasks", async (req) => {
    const provider = requireProvider(store);
    const q = req.query as Record<string, unknown>;
    const filter: TaskFilter = {};
    if (typeof q.status === "string") {
      filter.status = q.status.split(",") as TaskStatus[];
    }
    if (typeof q.priority === "string") {
      filter.priority = q.priority.split(",").map(Number) as TaskPriority[];
    }
    if (q.ready === "true" || q.ready === "1") {
      filter.ready = true;
    }
    return provider.list(filter);
  });

  // GET /api/tasks/:id — get a single task
  fastify.get("/api/tasks/:id", async (req, reply) => {
    const provider = requireProvider(store);
    const { id } = req.params as { id: string };
    const task = await provider.get(id);
    if (!task) {
      reply.code(404);
      return { error: "task not found" };
    }
    return task;
  });

  // POST /api/tasks — create a new task
  fastify.post("/api/tasks", async (req, reply) => {
    const provider = requireProvider(store);
    const body = parseJsonBody(req.body);
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      reply.code(400);
      return { error: "title is required" };
    }
    const input: TaskInput = { title };
    if (typeof body.description === "string") input.description = body.description;
    if (typeof body.status === "string") input.status = body.status as TaskStatus;
    if (typeof body.priority === "number") input.priority = body.priority as TaskPriority;
    if (Array.isArray(body.links)) input.links = body.links;
    return provider.create(input);
  });

  // PATCH /api/tasks/:id — update a task
  fastify.patch("/api/tasks/:id", async (req) => {
    const provider = requireProvider(store);
    const { id } = req.params as { id: string };
    const body = parseJsonBody(req.body);
    const changes: TaskUpdate = {};
    if (typeof body.title === "string") changes.title = body.title;
    if (typeof body.description === "string") changes.description = body.description;
    if (typeof body.status === "string") changes.status = body.status as TaskStatus;
    if (typeof body.priority === "number") changes.priority = body.priority as TaskPriority;
    if (Array.isArray(body.addLinks)) changes.addLinks = body.addLinks;
    if (Array.isArray(body.removeLinks)) changes.removeLinks = body.removeLinks;
    return provider.update(id, changes);
  });

  // POST /api/tasks/:id/transition — change task status
  fastify.post("/api/tasks/:id/transition", async (req, reply) => {
    const provider = requireProvider(store);
    const { id } = req.params as { id: string };
    const body = parseJsonBody(req.body);
    const status = typeof body.status === "string" ? body.status as TaskStatus : null;
    if (!status) {
      reply.code(400);
      return { error: "status is required" };
    }
    return provider.transition(id, status);
  });

  // DELETE /api/tasks/:id — delete a task
  fastify.delete("/api/tasks/:id", async (req) => {
    const provider = requireProvider(store);
    const { id } = req.params as { id: string };
    await provider.delete(id);
    return { ok: true };
  });
}
