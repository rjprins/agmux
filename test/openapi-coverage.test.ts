import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

const ROUTES_DIR = path.resolve("src/server/routes");
const OPENAPI_PATH = path.resolve("docs/openapi.json");

function toOpenApiPath(routePath: string): string {
  return routePath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function collectApiRouteOperations(): Set<string> {
  const files = fs.readdirSync(ROUTES_DIR).filter((name) => name.endsWith(".ts"));
  const ops = new Set<string>();
  const routePattern = /fastify\.(get|post|put|patch|delete)\("([^"]+)"/g;

  for (const file of files) {
    const fullPath = path.join(ROUTES_DIR, file);
    const source = fs.readFileSync(fullPath, "utf8");
    for (const match of source.matchAll(routePattern)) {
      const method = match[1] as HttpMethod;
      const routePath = match[2];
      if (!routePath.startsWith("/api/")) continue;
      ops.add(`${method.toLowerCase()} ${toOpenApiPath(routePath)}`);
    }
  }

  return ops;
}

function collectOpenApiOperations(): Set<string> {
  const source = fs.readFileSync(OPENAPI_PATH, "utf8");
  const spec = JSON.parse(source) as {
    paths?: Record<string, Partial<Record<HttpMethod, unknown>>>;
  };
  const ops = new Set<string>();
  for (const [p, methods] of Object.entries(spec.paths ?? {})) {
    for (const m of ["get", "post", "put", "patch", "delete"] as const) {
      if (methods[m]) ops.add(`${m} ${p}`);
    }
  }
  return ops;
}

describe("openapi coverage", () => {
  it("documents every current /api route operation", () => {
    const routeOps = collectApiRouteOperations();
    const specOps = collectOpenApiOperations();

    const missingInSpec = [...routeOps].filter((op) => !specOps.has(op));
    const unknownToRoutes = [...specOps].filter((op) => !routeOps.has(op));

    expect(
      { missingInSpec, unknownToRoutes },
      "All /api route operations must be represented in docs/openapi.json",
    ).toEqual({ missingInSpec: [], unknownToRoutes: [] });
  });
});
