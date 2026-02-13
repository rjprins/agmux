/**
 * Trigger module (hot reloaded).
 *
 * Export either:
 * - `export const triggers = [...]`
 * - OR `export default [...]`
 */

export const triggers = [
  {
    name: "proceed_prompt",
    // Many prompts are printed without a trailing newline, so chunk matching is usually best.
    scope: "chunk",
    pattern: /proceed \(y\)\?/i,
    cooldownMs: 1500,
    onMatch: ({ ptyId, ts, match, line, emit }) => {
      emit({
        type: "trigger_fired",
        ptyId,
        trigger: "proceed_prompt",
        match: match[0] ?? "",
        line,
        ts,
      });
      emit({ type: "pty_highlight", ptyId, reason: "trigger:proceed_prompt", ttlMs: 2000 });
    },
  },
];
