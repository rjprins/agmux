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
- `http://127.0.0.1:5173`

## Triggers

Edit `triggers/index.js`. The server watches the `triggers/` folder and hot-reloads on change.

Example trigger is included for `proceed (y)?` and will highlight the PTY in the UI.

Quick manual test:
- Command: `bash`
- Args: `["-lc","echo ready; read -p 'proceed (y)? ' x; echo done"]`

## Config

Environment variables:
- `HOST` (default `127.0.0.1`)
- `PORT` (default `5173`)
- `DB_PATH` (default `data/agent-tide.db`)
- `TRIGGERS_PATH` (default `triggers/index.js`)

## Notes

- Persistence is metadata-only: prior PTYs remain visible after restart, but the underlying processes do not survive.
- WebSocket output is batched (flush every ~16ms) to keep a clear path toward performance without early over-optimization.
