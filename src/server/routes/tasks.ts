import type { FastifyInstance } from "fastify";
import path from "node:path";
import type { SqliteStore } from "../../persist/sqlite.js";
import type { TaskFilter, TaskInput, TaskPriority, TaskProviderType, TaskStatus, TaskUpdate } from "../../tasks/types.js";
import { parseJsonBody } from "../auth.js";
import {
  clearTaskProviderConfig,
  createTaskProvider,
  getTaskProvider,
  getTaskProviderConfig,
  setTaskProviderConfig,
} from "../../tasks/registry.js";
import { pathExistsAndIsDirectory } from "../utils.js";

type TaskRoutesDeps = {
  fastify: FastifyInstance;
  store: SqliteStore;
};

const TASK_PROVIDER_TYPES = new Set<TaskProviderType>(["beads", "jira", "azure-devops"]);

async function parseProjectRoot(raw: unknown, required: true): Promise<string>;
async function parseProjectRoot(raw: unknown, required: false): Promise<string | null>;
async function parseProjectRoot(raw: unknown, required: boolean): Promise<string | null> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    if (required) throw { statusCode: 400, message: "projectRoot is required" };
    return null;
  }
  const projectRoot = path.resolve(raw.trim());
  if (!(await pathExistsAndIsDirectory(projectRoot))) {
    throw { statusCode: 400, message: `project directory not found: ${projectRoot}` };
  }
  return projectRoot;
}

function parseProviderConfig(body: Record<string, unknown>): { type: TaskProviderType; options?: Record<string, unknown> } {
  const type = typeof body.type === "string" ? body.type.trim() as TaskProviderType : null;
  if (!type || !TASK_PROVIDER_TYPES.has(type)) {
    throw { statusCode: 400, message: "type must be one of: beads, jira, azure-devops" };
  }
  if (body.options != null && (typeof body.options !== "object" || Array.isArray(body.options))) {
    throw { statusCode: 400, message: "options must be an object" };
  }
  return { type, options: body.options as Record<string, unknown> | undefined };
}

function requireProvider(store: SqliteStore, projectRoot?: string | null) {
  const provider = getTaskProvider(store, projectRoot);
  if (!provider) {
    const scope = projectRoot ? ` for project ${projectRoot}` : "";
    throw { statusCode: 404, message: `no task provider configured${scope}` };
  }
  return provider;
}

export function registerTaskRoutes(deps: TaskRoutesDeps): void {
  const { fastify, store } = deps;

  // GET /api/tasks/provider — current provider info for optional project root
  fastify.get("/api/tasks/provider", async (req) => {
    const q = req.query as Record<string, unknown>;
    const projectRoot = await parseProjectRoot(q.projectRoot, false);
    const config = getTaskProviderConfig(store, projectRoot);
    if (!config) return { configured: false, projectRoot };
    let provider;
    try {
      provider = getTaskProvider(store, projectRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { configured: true, projectRoot, type: config.type, error: message };
    }
    if (!provider) return { configured: false, projectRoot };
    return {
      configured: true,
      projectRoot,
      type: config.type,
      name: provider.name,
      capabilities: provider.capabilities,
    };
  });

  // PUT /api/tasks/provider — save provider setup for a project
  fastify.put("/api/tasks/provider", async (req, reply) => {
    const body = parseJsonBody(req.body);
    const projectRoot = await parseProjectRoot(body.projectRoot, true);
    const config = parseProviderConfig(body);
    let provider;
    try {
      provider = createTaskProvider(config, projectRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.code(400);
      return { ok: false, error: message };
    }
    setTaskProviderConfig(store, projectRoot, config);
    return {
      ok: true,
      configured: true,
      projectRoot,
      type: config.type,
      name: provider.name,
      capabilities: provider.capabilities,
    };
  });

  // POST /api/tasks/provider/verify — verify provider setup without saving
  fastify.post("/api/tasks/provider/verify", async (req, reply) => {
    const body = parseJsonBody(req.body);
    const projectRoot = await parseProjectRoot(body.projectRoot, true);
    const config = parseProviderConfig(body);
    try {
      const provider = createTaskProvider(config, projectRoot);
      await provider.list({});
      return {
        ok: true,
        projectRoot,
        type: config.type,
        name: provider.name,
        capabilities: provider.capabilities,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.code(400);
      return { ok: false, error: message };
    }
  });

  // DELETE /api/tasks/provider — clear provider setup for a project
  fastify.delete("/api/tasks/provider", async (req) => {
    const q = req.query as Record<string, unknown>;
    const projectRoot = await parseProjectRoot(q.projectRoot, true);
    clearTaskProviderConfig(store, projectRoot);
    return { ok: true, projectRoot };
  });

  // GET /api/tasks — list tasks with optional filters
  fastify.get("/api/tasks", async (req) => {
    const q = req.query as Record<string, unknown>;
    const projectRoot = await parseProjectRoot(q.projectRoot, false);
    const provider = requireProvider(store, projectRoot);
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
    const tasks = await provider.list(filter);
    return { projectRoot, tasks };
  });

  // GET /api/tasks/:id — get a single task
  fastify.get("/api/tasks/:id", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const projectRoot = await parseProjectRoot(q.projectRoot, false);
    const provider = requireProvider(store, projectRoot);
    const { id } = req.params as { id: string };
    const task = await provider.get(id);
    if (!task) {
      reply.code(404);
      return { error: "task not found" };
    }
    return { projectRoot, task };
  });

  // POST /api/tasks — create a new task
  fastify.post("/api/tasks", async (req, reply) => {
    const body = parseJsonBody(req.body);
    const q = req.query as Record<string, unknown>;
    const projectRoot = await parseProjectRoot(body.projectRoot ?? q.projectRoot, false);
    const provider = requireProvider(store, projectRoot);
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
    const task = await provider.create(input);
    return { projectRoot, task };
  });

  // PATCH /api/tasks/:id — update a task
  fastify.patch("/api/tasks/:id", async (req) => {
    const q = req.query as Record<string, unknown>;
    const body = parseJsonBody(req.body);
    const projectRoot = await parseProjectRoot(body.projectRoot ?? q.projectRoot, false);
    const provider = requireProvider(store, projectRoot);
    const { id } = req.params as { id: string };
    const changes: TaskUpdate = {};
    if (typeof body.title === "string") changes.title = body.title;
    if (typeof body.description === "string") changes.description = body.description;
    if (typeof body.status === "string") changes.status = body.status as TaskStatus;
    if (typeof body.priority === "number") changes.priority = body.priority as TaskPriority;
    if (Array.isArray(body.addLinks)) changes.addLinks = body.addLinks;
    if (Array.isArray(body.removeLinks)) changes.removeLinks = body.removeLinks;
    const task = await provider.update(id, changes);
    return { projectRoot, task };
  });

  // POST /api/tasks/:id/transition — change task status
  fastify.post("/api/tasks/:id/transition", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const body = parseJsonBody(req.body);
    const projectRoot = await parseProjectRoot(body.projectRoot ?? q.projectRoot, false);
    const provider = requireProvider(store, projectRoot);
    const { id } = req.params as { id: string };
    const status = typeof body.status === "string" ? body.status as TaskStatus : null;
    if (!status) {
      reply.code(400);
      return { error: "status is required" };
    }
    const task = await provider.transition(id, status);
    return { projectRoot, task };
  });

  // DELETE /api/tasks/:id — delete a task
  fastify.delete("/api/tasks/:id", async (req) => {
    const q = req.query as Record<string, unknown>;
    const body = parseJsonBody(req.body);
    const projectRoot = await parseProjectRoot(body.projectRoot ?? q.projectRoot, false);
    const provider = requireProvider(store, projectRoot);
    const { id } = req.params as { id: string };
    await provider.delete(id);
    return { ok: true, projectRoot };
  });
}
