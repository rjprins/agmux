# agent-tide

Local webserver that manages PTYs (subprocess terminals), streams output to the browser, and runs customizable trigger functions on terminal output.

## Run

Start everything (recommended):
```sh
npm run live
```

If you get "address already in use", pick different ports:
```sh
APP_PORT=4823 SUP_PORT=4824 npm run live
```

Open:
- App: `http://127.0.0.1:4821`
- Rollback UI: `http://127.0.0.1:4822`

## Live Self-Editable Mode (Supervisor)

The supervisor watches for edits (including edits made by agents inside PTYs), auto-commits them to git, rebuilds the UI when needed, restarts the server when needed, and triggers browser reloads. It also serves a rollback UI.

```sh
npm run live
```

Start app only (no supervisor / no auto-commit / no rollback UI):
```sh
npm run app
```

## E2E UI Tests (Playwright)

This repo is set up to use system Chromium at `/usr/bin/chromium` to avoid Playwright browser downloads.

Install:
```sh
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i -D @playwright/test
```

Run:
```sh
npm run e2e
```

Visible:
```sh
npm run e2e:headed
```

Interactive runner UI:
```sh
npm run e2e:ui
```

Debug (Playwright inspector):
```sh
npm run e2e:debug
```

Recommended supervisor install outside the repo (so PTY agents editing the repo can't easily modify rollback UI behavior):
```sh
cd /home/rutger/agent-tide/supervisor
GOCACHE=/tmp/go-build-cache go build -o ~/.local/bin/agent-tide-supervisor .
~/.local/bin/agent-tide-supervisor -repo /home/rutger/agent-tide -app-port 4821 -sup-port 4822
```

Optional hardening (Linux): make the installed supervisor binary non-writable for the PTY agent user.

## Triggers

Edit `triggers/index.js`. The server watches the `triggers/` folder and hot-reloads on change.

Example trigger is included for `proceed (y)?` and will highlight the PTY in the UI.

Quick manual test:
- Command: `bash`
- Args: `["-lc","echo ready; read -p 'proceed (y)? ' x; echo done"]`

UI note: clicking "New PTY" creates a default interactive shell (no dialogs). To run the manual trigger test, paste the command into the input box and press Enter.

## Config

Environment variables:
- `HOST` (default `127.0.0.1`)
- `PORT` (default `4821`)
- `DB_PATH` (default `data/agent-tide.db`)
- `TRIGGERS_PATH` (default `triggers/index.js`)

## Notes

- Plain PTYs (created via `/api/ptys`) are not persistent: if the Node server stops, those processes stop too.
- The default "New PTY" shell is tmux-backed (see below), so it survives Node server restarts.
- WebSocket output is batched (flush every ~16ms) to keep a clear path toward performance without early over-optimization.

## Agent Persistence (tmux)

By default, "New PTY" creates a tmux-backed shell. This means:
- If the Node server restarts/crashes, the tmux session (and anything running in it) continues.
- When the server comes back, it reattaches to known tmux sessions from SQLite and streaming resumes.
