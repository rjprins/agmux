# Dependencies

## Runtime (required)

| Dependency | Why |
|---|---|
| **Node.js** (v22+) | Runs the server |
| **npm** | Package management, native addon compilation |
| **tmux** | Default PTY backend for persistent sessions |
| **build-essential** | `node-pty` and `better-sqlite3` compile native C/C++ addons |
| **git** | Worktrees, repo metadata, general workflow |

## Agents (run inside PTYs)

| Agent | Readiness detection |
|---|---|
| **Claude Code** | Yes — explicit Claude `Notification` hooks |
| **Codex CLI** | Yes — explicit Codex `notify` callback |
| Any other CLI | No built-in readiness signaling |

## Dev only

| Dependency | Why |
|---|---|
| **Playwright** | End-to-end tests (`npm run e2e`) |
