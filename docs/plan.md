# Agent Tide Plan

## Goal

Build `agent-tide` as a web-first multi-session control surface (xterm.js + status/context/history/info), with pluggable backends (`tmux`, `pty`, later `openclaw`) and strong status detection inspired by `agent-deck`.

## Target Features

- Session lifecycle controls: `add/start/stop/restart/attach/fork/send/output`
- Multi-tool support: Claude, Gemini, OpenCode, Codex, plus custom tools
- Session status tracking: `running / waiting / idle / error` with strong Claude support and optional hooks
- Grouping, filtering, and fuzzy search across sessions
- Waiting-session notification bar for quick attention routing

## Core Product Direction

- Web UI is the product core.
- Provider backends are replaceable integrations.
- Start with `tmux` provider (what exists now), then generalize.
- Keep hook integration optional and additive (never required).
- Status engine baseline comes from `agent-deck` logic; adapt/port first, then tune.

## Main Weaknesses To Fix First

- Status/readiness logic is too entangled in `src/server.ts`.
- No strict provider interfaces yet.
- Heuristics are brittle against chunking and CLI output changes.
- State machine behavior is implicit; transitions/hysteresis are hard to reason about.
- Tests are not yet replay-grade for transcript/chunk boundary cases.

## Status Logic Source Of Truth

For status/readiness behavior, do not invent a new heuristic stack first.
Port and adapt the proven `agent-deck` approach as primary baseline:

- Pattern catalog + compile/merge model (`internal/tmux/patterns.go`)
- Tool-aware prompt detector with busy-first precedence (`internal/tmux/detector.go`)
- Busy detection with spinner/context handling + grace period (`internal/tmux/tmux.go`)
- Activity/spike filtering + hysteresis ideas (`internal/tmux/tmux.go`)
- Optional Claude hook path (`internal/session/claude_hooks.go`, `internal/session/hook_watcher.go`)

Agent Tide adapts this into web semantics (`ready/busy/unknown`) while preserving the detection ordering and anti-flicker strategy.

## Implementation Phases

## Phase 0: Baseline + Guardrails

- Lock current behavior with transcript fixtures and chunked replay tests.
- Add deterministic unit tests for state transitions (`busy/ready/unknown` and future `running/waiting/idle/error` mapping).
- Add debug trace output for status decisions (reason + signal source + timestamp).

Acceptance:

- Regressions in known flicker cases are caught by tests.
- Every status change has an inspectable reason.

## Phase 1: Provider Abstraction (tmux-first)

- Introduce provider contracts:
  - `RuntimeProvider` (start/stop/send/resize/output)
  - `StatusProvider` (readiness/session status)
  - `WorktreeProvider` (create/list/finish/cleanup)
- Extract existing tmux logic into `TmuxProvider`.
- Keep API/UI behavior unchanged while refactoring.

Acceptance:

- Server uses provider interfaces, not tmux-specific branches in core flow.
- Existing tmux behavior remains stable.

## Phase 2: Session Lifecycle Parity

- Implement robust lifecycle actions with clear idempotency and error handling:
  - `add/start/stop/restart/attach/fork/send/output`
- Ensure actions are available from UI without fullscreen context switching.
- Add provider capability flags so unsupported actions are hidden/disabled cleanly.

Acceptance:

- Lifecycle actions work end-to-end for tmux sessions.
- UI reflects capability differences without broken controls.

## Phase 3: Multi-Tool + Status Engine

- Port `agent-deck` status internals first (adapted for web backend boundaries):
  - pattern pack defaults + merge/compile
  - prompt detector ordering
  - busy indicator precedence
  - spinner grace + activity spike filtering
- Split per-tool status detection into adapter packs (Claude/Codex/Gemini/OpenCode/custom).
- Implement explicit status state machine with hysteresis/grace windows.
- Add optional Claude hook input path with fallback to pattern detection.

Acceptance:

- Stable status in known Claude/Codex scenarios.
- Hooks can be enabled/disabled without breaking baseline detection.
- Replay parity tests confirm adapted behavior matches expected outcomes from agent-deck-derived fixtures.

## Phase 4: Grouping, Filter, Search

- Add session grouping model and persisted group metadata.
- Implement filter/sort/fuzzy search in UI and API.
- Preserve current web workflow (no hard dependency on keybindings).

Acceptance:

- Fast search/filter across active sessions.
- Group state persists and survives restarts.

## Phase 5: Waiting Attention Bar

- Add waiting-session notification bar (web-native).
- Add acknowledge/snooze behavior to reduce noise.
- Support quick-jump and quick-action from notification items.

Acceptance:

- Users can quickly route to sessions needing input.
- No high-frequency flicker or duplicate spam in attention UI.

## Phase 6: OpenClaw Provider (After tmux Stabilization)

- Implement `OpenClawProvider` behind same contracts.
- Normalize provider-specific states into shared session/status model.
- Keep tmux and openclaw usable side-by-side.

Acceptance:

- Same UI flow works for tmux and openclaw sessions.
- Provider-specific failures are isolated and visible.

## Data/Model Notes

- Maintain two related but distinct concepts:
  - `process/session state` (e.g. running, waiting, idle, error)
  - `readiness indicator` (e.g. ready, busy, unknown)
- Keep a mapping layer so UI can render both a high-level status and a low-level indicator without ambiguity.

## Immediate Next Sprint (Concrete)

1. Add `src/providers/types.ts` and tmux provider scaffold.
2. Move status decision code from `src/server.ts` into a dedicated status engine module.
3. Port agent-deck-style pattern catalog + detector ordering into that module.
4. Add transcript replay tests with randomized chunk boundaries and parity fixtures.
5. Add status decision tracing endpoint/logging for debugging.
