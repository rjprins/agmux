# Todo

Core reliability and usability

* Fix garbled PTYs after refresh
* Add proper scrollback support
* Add scroll to bottom button and auto-scroll toggle
* Show PTY window title dynamically
* Tighten UI spacing, alignment, and visual hierarchy
* Improve session naming defaults
* Improve session switching speed

Launch and session awareness

* Add quick launch panel
* Allow additional agent args in launch panel
* Add explicit input required session status
* Show clear running, idle, and waiting states

Projects

* Promote pinned directories to projects
* Add pin project action
* Auto-detect candidate projects from session directories
* Auto-pin first detected project
* Persist project settings
* Add default agent args per project
* Remember last used project settings
* Store project metadata cleanly

Session organization and layouts

* Connect to multiple tmux sessions
* Hide and show sessions
* Add preset layouts (focus, grid, stage)
* Allow assigning sessions to layout slots
* Persist layout per project

Tool API

* Add tool API to list sessions
* Add tool API to read session output
* Add tool API to send input to session
* Add tool API to set session status
* Add tool API to list projects
* Add tool API to read and write project settings
* Allow agents to register status
* Allow agents to request attention
* Add authentication for tool API

Tickets and workflows

* Add ticket provider protocol
* Add todo.md ticket provider
* Add GitHub issues ticket provider
* Allow assigning tickets to agents
* Add prompt snippets per project
* Add workflow snippets

Mobile and secondary UX

* Improve mobile monitoring view

Restore sessions

- [x] Separate reconnect from restore in product model and code comments
- [x] Keep runtime terminal reconnect fully automatic (no inactive "restore terminal" action)
- [x] Restrict explicit restore to Claude/Codex/Pi agent sessions only
- [x] Stop mixing log-discovered sessions into `/api/ptys`; return runtime PTYs only
- [x] Add dedicated agent-session persistence table keyed by `(provider, provider_session_id)`
- [x] Store `cwd` plus `cwd_source` (`runtime`, `db`, `log`, `user`) and `last_seen_at`
- [x] Merge agent sessions from logs + db by canonical key with source-priority for cwd
- [x] Add `GET /api/agent-sessions` endpoint for restore candidates
- [x] Add `POST /api/agent-sessions/:provider/:sessionId/restore` endpoint
- [x] Add optional restore target selection: same cwd, existing worktree, or new worktree
- [x] Replace current inactive sidebar with "Recent agent sessions"
- [x] Group recent agent sessions by project root, then worktree subgroup
- [x] Add per-session action menu: restore, restore in worktree, edit cwd, hide
- [x] Add provenance badge per row (`runtime`, `db`, `log`) to show confidence
- [x] Persist collapsed state for project/worktree groups in preferences
- [ ] Add tests for grouped recent sessions UI and restore endpoint behavior
