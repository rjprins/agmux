# Deferred To-dos (From agmux vs myrlin comparison)

These were intentionally deferred for later pickup.

5. Add git status API parity
- Add branch, dirty, ahead, and behind endpoint(s) for worktree cards and session list rows.

6. Add branch and worktree metadata in UI
- Show branch and dirty badge in PTY list and grouped views for safer close/remove decisions.

7. Improve reconnect replay depth
- For tmux-backed sessions, increase subscribe-time replay depth (for example `capture-pane -S -2000`) so reconnect restores more context.
- For non-tmux backend, evaluate a bounded server-side output buffer per PTY.

8. Add targeted tests for hard paths
- Add tests for path validation, auth on GET APIs, branch creation logic with base branch, and dirty worktree removal flow.
