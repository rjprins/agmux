#!/usr/bin/env node

const provider = (process.argv[2] ?? "").trim();
const reason = (process.argv[3] ?? "").trim();
const state = (process.argv[4] ?? "ready").trim() || "ready";

const apiBase = (process.env.AGMUX_API_BASE ?? "").trim();
const ptyId = (process.env.AGMUX_PTY_ID ?? "").trim();
const tmuxSession = (process.env.AGMUX_TMUX_SESSION ?? "").trim();
const token = (process.env.AGMUX_TOKEN ?? "").trim();

if (!apiBase || (!ptyId && !tmuxSession) || !provider) {
  process.exit(0);
}

const headers = { "content-type": "application/json" };
if (token) headers["x-agmux-token"] = token;

const response = await fetch(`${apiBase}/api/readiness/report`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    ptyId: ptyId || undefined,
    tmuxSession: tmuxSession || undefined,
    provider,
    reason,
    state,
  }),
});

if (!response.ok) {
  const body = await response.text().catch(() => "");
  const message = body ? ` ${body}` : "";
  throw new Error(`AGMUX readiness callback failed: ${response.status}${message}`);
}
