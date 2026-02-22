# Mobile Agent UI Plan

Goal: ship a mobile-first interface for agmux that favors agent workflows over terminal fidelity, while keeping backend behaviors intact.

- [x] Define mobile information architecture: focus panel, composer, sessions list, attention queue, agent restore list
- [x] Build mobile view model + rendering layer (`src/ui/mobile-view.tsx`)
- [x] Wire mobile state to existing runtime data (PTY list, readiness, triggers, agent sessions)
- [x] Implement command composer that sends input without xterm focus
- [x] Add attention queue sourced from trigger events
- [x] Add agent preview sheet and reuse restore workflow
- [x] Add responsive styling, typography, and motion for small screens
- [x] Add Playwright e2e test for mobile composer flow

Notes
- Mobile UI hides the desktop shell, but keeps xterm running off-screen for output capture.
- Output previews are read from the xterm buffer and capped for performance.
