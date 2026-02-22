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
| **Claude Code** | Yes — pane activity + prompt/permission inference |
| **Codex CLI** | Yes — pane activity + prompt/permission inference |
| Any other CLI | Yes — pane activity + prompt/permission inference |

## Dev only

| Dependency | Why |
|---|---|
| **Playwright** | End-to-end tests (`npm run e2e`) |
