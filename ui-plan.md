# UI Migration Plan

1. Freeze current slice and checkpoint.
2. Add or adjust e2e coverage for the migrated PTY list and launch modal flows.
3. Migrate `input-context` UI to Preact (`src/ui/app.ts` logic moved into a new TSX view).
4. Extract frontend state into a dedicated module (`activePty`, grouping, inactive pagination, launch modal state).
5. Extract websocket and API side effects into a controller module (subscribe, refresh, launch, kill, tmux attach).
6. Extract xterm lifecycle into a terminal module (create, dispose, resize, reflow, visibility), keep imperative.
7. Reduce `src/ui/app.ts` to composition and bootstrap only (wire state, controller, and views).
8. Remove obsolete imperative DOM builders and duplicate render paths.
9. Run full verification: `npm run -s ui:build`, `npm test`, `npm run -s e2e`.
10. Document architecture and migration rules in `docs/` (declarative views, imperative terminal boundary).
