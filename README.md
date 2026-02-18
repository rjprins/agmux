# agmux

Local web UI for managing agent terminal sessions. Streams PTY output to the browser over WebSockets, with customizable triggers and agent readiness detection.

Built for managing [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), and other CLI-based coding agents — but works with any terminal program.

## Features

- **Web-based terminal viewer** — real-time PTY output streamed via WebSockets
- **tmux-backed sessions** — agent sessions survive server restarts
- **Trigger system** — pattern-match on terminal output and run custom actions
- **Readiness detection** — detect when sessions are actively working vs waiting for input
- **Supervisor mode** — auto-commit, auto-reload, and rollback UI for self-editable development
- **Themeable UI** — 5 built-in themes
- **Multi-worktree support** — manage multiple git worktrees from one interface

## Prerequisites

- **Node.js** v22+
- **npm**
- **tmux** (for persistent sessions — the default backend)
- **C++ toolchain** (`build-essential` on Debian/Ubuntu) for native addons

On Ubuntu/Debian:
```sh
sudo apt install tmux build-essential
```

See [docs/dependencies.md](docs/dependencies.md) for the full list.

## Quick Start

```sh
git clone https://github.com/rjprins/agmux.git
cd agmux
npm install
npm run live
```

This starts the app with the supervisor (auto-rebuild, auto-reload, rollback UI).

- App: `http://127.0.0.1:4821`
- Rollback UI: `http://127.0.0.1:4822`

If you get "address already in use", pick different ports:
```sh
APP_PORT=4823 SUP_PORT=4824 npm run live
```

Start app only (no supervisor):
```sh
npm run app
```

## Supervisor

The supervisor watches for file edits (including edits made by agents inside PTYs), auto-commits them to git, rebuilds the UI when needed, restarts the server, and triggers browser reloads. It also serves a rollback UI.

For extra safety, you can install the supervisor binary outside the repo so PTY agents can't modify it:

```sh
cd supervisor
GOCACHE=/tmp/go-build-cache go build -o ~/.local/bin/agmux-supervisor .
~/.local/bin/agmux-supervisor -repo "$(pwd)/.." -app-port 4821 -sup-port 4822
```

Requires **Go 1.22+**. Optional hardening (Linux): make the installed supervisor binary non-writable for the PTY agent user.

## Triggers

Edit `triggers/index.js`. The server watches the `triggers/` folder and hot-reloads on change.

An example trigger is included that highlights the PTY in the UI when a `proceed (y)?` prompt is detected.

## Configuration

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `HOST` | `127.0.0.1` | Server bind address |
| `PORT` | `4821` | Server port |
| `DB_PATH` | `data/agmux.db` | SQLite database path |
| `TRIGGERS_PATH` | `triggers/index.js` | Trigger definitions file |
| `AGMUX_TOKEN` | *(random)* | Auth token (auto-generated if not set) |
| `AGMUX_SHELL` | `$SHELL` or `bash` | Shell for PTY sessions |
| `AGMUX_SHELL_BACKEND` | `tmux` | PTY backend: `tmux` or `pty` |
| `AGMUX_NO_OPEN` | `false` | Skip auto-opening browser |
| `AGMUX_ALLOW_NON_LOOPBACK` | `false` | Allow binding to non-localhost addresses |
| `AGMUX_ALLOWED_ORIGINS` | | Additional WebSocket origins (comma-separated) |

## Testing

```sh
# Unit tests
npm test

# E2E tests (Playwright)
npm run e2e

# E2E with browser visible
npm run e2e:headed
```

By default, E2E tests use Playwright's managed Chromium. Set `PLAYWRIGHT_CHROMIUM_PATH` to use a system browser instead.

To install Playwright's browser:
```sh
npx playwright install chromium
```

## Notes

- Plain PTYs (created via `/api/ptys`) are not persistent — if the Node server stops, those processes stop too.
- The default "New PTY" shell is tmux-backed, so it survives server restarts.
- WebSocket output is batched (~16ms flush interval) for performance.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities. agmux runs terminal sessions — please report security issues responsibly.

## License

[MIT](LICENSE)
