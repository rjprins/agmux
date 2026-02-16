# Dependencies

## Runtime (required)

| Dependency | Why |
|---|---|
| **Node.js** (v22+) | Runs the server |
| **npm** | Package management, native addon compilation |
| **tmux** | Default PTY backend for persistent sessions |
| **build-essential** | `node-pty` and `better-sqlite3` compile native C/C++ addons |
| **git** | Supervisor auto-commits, general workflow |

## Runtime (optional)

| Dependency | Why |
|---|---|
| **Go** (1.22+) | Build the supervisor for live-reload mode (`npm run live`) |

## Agents (run inside PTYs)

| Agent | Readiness detection |
|---|---|
| **Claude Code** | Yes — prompt, thinking, busy markers |
| **Codex CLI** | Yes — prompt, working markers |
| Any other CLI | Works, but no automatic readiness detection |

## Dev only

| Dependency | Why |
|---|---|
| **Playwright** | End-to-end tests (`npm run e2e`) |
