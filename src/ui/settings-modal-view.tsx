import { render } from "preact";

export type ThemeOption = {
  key: string;
  name: string;
};

export type SettingsModalViewModel = {
  worktreePathTemplate: string;
  previewPath: string;
  saving: boolean;
  themeKey: string;
  themes: ThemeOption[];
  tmuxSessionKey: string;
  tmuxSessions: Array<{ key: string; label: string }>;
};

export type SettingsModalHandlers = {
  onClose: () => void;
  onTemplateChange: (value: string) => void;
  onReset: () => void;
  onSave: () => void;
  onThemeChange: (key: string) => void;
  onTmuxSessionChange: (key: string) => void;
  onTmuxSessionFocus: () => void;
};

export function renderSettingsModal(
  root: Element,
  model: SettingsModalViewModel | null,
  handlers: SettingsModalHandlers,
): void {
  if (!model) {
    render(null, root);
    return;
  }

  render(
    <div
      className="launch-modal-overlay"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) handlers.onClose();
      }}
    >
      <div
        className="launch-modal"
        tabIndex={-1}
        ref={(el) => {
          if (el && el !== document.activeElement && !el.contains(document.activeElement)) el.focus();
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Escape") {
            ev.preventDefault();
            handlers.onClose();
          }
        }}
      >
        <h3>Settings</h3>

        <label className="launch-modal-label">
          Theme
          <select
            className="launch-modal-select"
            value={model.themeKey}
            onChange={(ev) => handlers.onThemeChange((ev.target as HTMLSelectElement).value)}
          >
            {model.themes.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        <label className="launch-modal-label">
          Attach tmux session
          <select
            id="tmux-session-select"
            className="launch-modal-select"
            value={model.tmuxSessionKey}
            onChange={(ev) => handlers.onTmuxSessionChange((ev.target as HTMLSelectElement).value)}
            onFocus={() => handlers.onTmuxSessionFocus()}
          >
            {model.tmuxSessions.map((session) => (
              <option key={session.key} value={session.key}>
                {session.label}
              </option>
            ))}
          </select>
        </label>

        <label className="launch-modal-label">
          Worktree path template
          <input
            type="text"
            className="launch-modal-input"
            value={model.worktreePathTemplate}
            placeholder="../{repo-name}-{branch}"
            onInput={(ev) => handlers.onTemplateChange((ev.target as HTMLInputElement).value)}
          />
        </label>

        <div className="settings-help">
          Variables: <code>{"{repo-name}"}</code> <code>{"{branch}"}</code> <code>{"{repo-root}"}</code>
          <br />
          Relative paths resolve against the repo root.
        </div>

        {model.previewPath && (
          <div className="settings-help">
            Preview: <code>{model.previewPath}</code>
          </div>
        )}

        <div className="launch-modal-buttons">
          <button type="button" onClick={() => handlers.onReset()} disabled={model.saving}>
            Reset to default
          </button>
          <button type="button" onClick={() => handlers.onClose()} disabled={model.saving}>
            Cancel
          </button>
          <button
            type="button"
            className="launch-modal-go"
            disabled={model.saving}
            onClick={() => handlers.onSave()}
          >
            {model.saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>,
    root,
  );
}
