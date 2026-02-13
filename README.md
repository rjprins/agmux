# agent-tide

Local webserver that manages PTYs (subprocess terminals), streams output to the browser, and runs customizable trigger functions on terminal output.

## Run

1. Build the browser bundle:
```sh
npm run ui:build
```

2. Start the server (dev):
```sh
npm run dev
```

3. Open:
- `http://127.0.0.1:4821`

## Live Self-Editable Mode (Supervisor)

The supervisor watches for edits (including edits made by agents inside PTYs), auto-commits them to git, rebuilds the UI when needed, restarts the server when needed, and triggers browser reloads. It also serves a rollback UI.

```sh
cd supervisor
go run . -repo .. -app-port 4821 -sup-port 4822
```

Recommended install outside the repo (so PTY agents editing the repo can't easily modify rollback UI behavior):
```sh
cd /home/rutger/agent-tide/supervisor
GOCACHE=/tmp/go-build-cache go build -o ~/.local/bin/agent-tide-supervisor .
~/.local/bin/agent-tide-supervisor -repo /home/rutger/agent-tide -app-port 4821 -sup-port 4822
```

Optional hardening (Linux):
- make the installed supervisor binary non-writable for the PTY agent user

Open:
- App: `http://127.0.0.1:4821`
- Rollback UI: `http://127.0.0.1:4822`

## Triggers

Edit `triggers/index.js`. The server watches the `triggers/` folder and hot-reloads on change.

Example trigger is included for `proceed (y)?` and will highlight the PTY in the UI.

Quick manual test:
- Command: `bash`
- Args: `["-lc","echo ready; read -p 'proceed (y)? ' x; echo done"]`

## Config

Environment variables:
- `HOST` (default `127.0.0.1`)
- `PORT` (default `4821`)
- `DB_PATH` (default `data/agent-tide.db`)
- `TRIGGERS_PATH` (default `triggers/index.js`)

## Notes

- Persistence is metadata-only: prior PTYs remain visible after restart, but the underlying processes do not survive.
- WebSocket output is batched (flush every ~16ms) to keep a clear path toward performance without early over-optimization.
