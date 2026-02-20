# Refactor Plan and Review Findings

Date: 2026-02-20

## Goals
- Remove dead abstractions and converge on the tmux-only runtime.
- Establish a shared API schema to prevent server/UI drift.
- Split the server into cohesive modules with clear ownership.
- Centralize git/worktree logic for consistent validation and security.
- Add integration tests that cover high-risk flows.

## Status
- [x] Shared API schema (`src/shared/protocol.ts`) wired into server + UI
- [x] Removed unused provider abstraction (`src/providers/*`)
- [x] Split server into config, auth, runtime, routes, ws, and helpers
- [x] Centralized git/worktree logic into `src/server/worktrees.ts`
- [x] Added targeted integration tests for REST + WS wiring
- [x] Readiness engine: shell-active-process handling, quiet fallback, capture fallback
- [x] CWD updates: input parsing cleanup + client-side fallback + active group ordering
- [x] Input history persistence: sessionStorage fallback for reloads
- [x] Settings modal: prevent late settings fetch from overwriting user edits
- [x] Tests: `npm run -s test`, `npm run -s e2e`

## Findings (Structure and Abstractions)
1. High: Unused provider abstraction creates drift and confusion. `src/providers/*` is not used by runtime, while `src/server.ts` + `src/tmux.ts` + `PtyManager` handle real behavior. This is a classic “vibe-coded” forked abstraction. File refs: `src/providers/types.ts`, `src/providers/tmux.ts`, `src/server.ts`, `src/tmux.ts`.
2. High: Wire/domain types are duplicated across server and UI (`PtySummary`, `ServerToClientMessage`, readiness enums, `TmuxServer`). This risks silent breakage when the server changes. File refs: `src/types.ts`, `src/ui/app.ts`, `src/ui/pty-list-view.tsx`, `src/tmux.ts`.
3. High: `src/server.ts` is a god module containing config, auth, persistence, tmux reconciliation, readiness, triggers, log discovery, worktrees, REST handlers, and WS handling. State is spread across globals and maps, making changes risky. File refs: `src/server.ts`.
4. Medium: Worktree and git logic is split between `src/worktree.ts` and ad‑hoc server routes, which makes reuse inconsistent and validation incomplete. File refs: `src/worktree.ts`, `src/server.ts`.
5. Medium: Log discovery uses sync filesystem scanning/parsing in user-facing flows and duplicates resume‑arg logic. It can block the event loop and diverge from server rules. File refs: `src/logSessions.ts`, `src/server.ts`.
6. Medium: UI is a mix of imperative DOM + Preact components with global state in `app.ts`, encouraging fragile mutation patterns. File refs: `src/ui/app.ts`, `src/ui/pty-list-view.tsx`.
7. Medium: Readiness logic is implemented twice (heuristic engine vs provider status). If provider abstraction is reintroduced, semantics will diverge. File refs: `src/readiness/engine.ts`, `src/providers/tmux.ts`.
8. Low: Dead/unused code and state smells (`isPathInside` unused, `ReadinessEngine.outputBuffer` unused, persisted `backend` ignored on load). Typical AI leftovers. File refs: `src/server.ts`, `src/readiness/engine.ts`, `src/persist/sqlite.ts`.
9. Low: Alternate screen stripping is a global output hack. It preserves scrollback but can break full‑screen apps; it is not configurable. File refs: `src/server.ts`.
10. Medium: Settings modal had a race where the async settings fetch could overwrite a user's typed template just before save, resulting in empty persisted settings. File refs: `src/ui/app.ts`, `src/server/routes/settings.ts`.
11. Medium: Readiness relied on tmux capture even when it fails, and shell processes were reported as active, keeping PTYs “busy” after quick commands. File refs: `src/readiness/engine.ts`, `src/tmux.ts`.
12. Medium: CWD grouping depended solely on tmux updates; when tmux capture/input parsing missed a `cd`, the UI never regrouped. Added client-side fallback and made active group sort first. File refs: `src/readiness/engine.ts`, `src/ui/app.ts`.
13. Low: Input history persistence could be lost on reload due to debounce-only server writes; a sessionStorage fallback avoids losing last input. File refs: `src/ui/app.ts`, `src/server/routes/ptys.ts`.

## Concrete Plan
### 1) Shared API Schema
- Create a shared module (e.g. `src/shared/protocol.ts`).
- Move these definitions into shared:
  - `PtySummary`, `ClientToServerMessage`, `ServerToClientMessage`
  - readiness enums, `TmuxServer`
  - shared REST payloads (`AgentSessionSummary`, `TmuxSessionInfo`, `TmuxSessionCheck`)
- Server: re‑export from shared (retire `src/types.ts` or make it a re‑export).
- UI: import from shared instead of local duplicates.
- Optional: add runtime validation (zod/valibot) for WS + REST payloads.

### 2) Remove Provider Abstraction
- Delete `src/providers/*`.
- Clean references and tests.
- This locks the codebase to the tmux-only architecture.

### 3) Split Server Into Modules
Suggested layout:
- `src/server/config.ts`: env parsing, constants
- `src/server/auth.ts`: token parsing/validation + request hook
- `src/server/agents.ts`: agent session discovery/persistence/merge/restore
- `src/server/ptys.ts`: PTY manager wiring, readiness engine, output/exit handlers
- `src/server/tmux-reconcile.ts`: reconcile logic + linked session cleanup
- `src/server/worktrees.ts`: worktree ops and validation
- `src/server/routes/*.ts`: REST endpoints per concern
- `src/server/ws.ts`: WebSocket upgrade + message handling
- `src/server/index.ts`: app wiring + listen

### 4) Centralize Git/Worktree Logic
- Move branch validation and worktree creation/status into `src/server/worktrees.ts`.
- Reuse `src/worktree.ts` for caching + path resolution.
- Ensure all git exec logic runs through one validation path.

### 5) Add Targeted Integration Tests
- Fastify `inject` tests for:
  - `/api/ptys` and readiness payload shape
  - `/api/agent-sessions` + restore target handling
  - `/api/worktrees` + `/api/worktrees/status`
- WebSocket smoke test for `pty_list` + `pty_output` shapes.

## Notes
- This plan prioritizes structural clarity and drift prevention before behavior changes.
- The shared API schema is the main guardrail against server/UI inconsistency.
