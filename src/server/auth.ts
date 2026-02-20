import type { FastifyInstance } from "fastify";
import { AUTH_ENABLED, AUTH_TOKEN, WS_ALLOWED_ORIGINS } from "./config.js";
import { isRecord } from "./utils.js";

function parseTokenFromAuthHeader(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(value.trim());
  if (!m) return null;
  const token = m[1].trim();
  return token.length > 0 ? token : null;
}

export function parseTokenFromHeaders(headers: Record<string, unknown>): string | null {
  const direct = headers["x-agmux-token"];
  if (typeof direct === "string" && direct.length > 0) return direct;
  if (Array.isArray(direct)) {
    for (const v of direct) {
      if (typeof v === "string" && v.length > 0) return v;
    }
  }
  const auth = headers.authorization;
  if (Array.isArray(auth)) {
    for (const v of auth) {
      const token = parseTokenFromAuthHeader(v);
      if (token) return token;
    }
    return null;
  }
  return parseTokenFromAuthHeader(auth);
}

export function parseTokenFromUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl, "http://localhost");
    const token = url.searchParams.get("token");
    return token && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export function isTokenValid(headerToken: string | null, urlToken: string | null): boolean {
  if (!AUTH_ENABLED) return true;
  const token = headerToken ?? urlToken;
  return token != null && token === AUTH_TOKEN;
}

export function requestNeedsToken(method: string, rawUrl: string | undefined): boolean {
  if (!AUTH_ENABLED) return false;
  if (method.toUpperCase() === "OPTIONS") return false;
  return (rawUrl ?? "").startsWith("/api/");
}

export function isWsOriginAllowed(origin: string | undefined): boolean {
  if (!origin || origin.length === 0) return true;
  return WS_ALLOWED_ORIGINS.has(origin.toLowerCase());
}

export function registerAuthHook(fastify: FastifyInstance): void {
  fastify.addHook("onRequest", async (req, reply) => {
    if (!requestNeedsToken(req.raw.method ?? "GET", req.raw.url)) return;
    const headerToken = parseTokenFromHeaders(req.headers as unknown as Record<string, unknown>);
    const urlToken = parseTokenFromUrl(req.raw.url);
    if (isTokenValid(headerToken, urlToken)) return;
    reply.code(401);
    return { error: "missing or invalid auth token" };
  });
}

export function parseJsonBody(raw: unknown): Record<string, unknown> {
  return isRecord(raw) ? raw : {};
}
