import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, test } from "vitest";
import { SqliteStore } from "../src/persist/sqlite.js";
import { registerTaskRoutes } from "../src/server/routes/tasks.js";

describe("task provider setup routes", () => {
  let tmpRoot: string | null = null;

  afterEach(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  test("PUT/GET/DELETE /api/tasks/provider stores project-scoped setup", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-task-routes-"));
    const projectRoot = path.join(tmpRoot, "project-a");
    await fs.mkdir(projectRoot, { recursive: true });

    const store = new SqliteStore(path.join(tmpRoot, "app.db"));
    const fastify = Fastify();
    registerTaskRoutes({ fastify, store });

    const put = await fastify.inject({
      method: "PUT",
      url: "/api/tasks/provider",
      payload: {
        projectRoot,
        type: "beads",
        options: { bin: "bd" },
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      ok: true,
      configured: true,
      projectRoot,
      type: "beads",
      name: "beads",
    });

    const get = await fastify.inject({
      method: "GET",
      url: `/api/tasks/provider?projectRoot=${encodeURIComponent(projectRoot)}`,
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({
      configured: true,
      projectRoot,
      type: "beads",
      name: "beads",
    });

    const del = await fastify.inject({
      method: "DELETE",
      url: `/api/tasks/provider?projectRoot=${encodeURIComponent(projectRoot)}`,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ ok: true, projectRoot });

    const getAfter = await fastify.inject({
      method: "GET",
      url: `/api/tasks/provider?projectRoot=${encodeURIComponent(projectRoot)}`,
    });
    expect(getAfter.statusCode).toBe(200);
    expect(getAfter.json()).toEqual({ configured: false, projectRoot });

    await fastify.close();
  });
});
