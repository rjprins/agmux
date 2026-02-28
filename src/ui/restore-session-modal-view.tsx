import { render } from "preact";

export type RestoreTargetChoice = "same_cwd" | "worktree" | "new_worktree" | "custom_cwd";

export type RestoreSessionModalViewModel = {
  sessionTitle: string;
  sessionSubtitle: string;
  provider: string;
  providerSessionId: string;
  target: RestoreTargetChoice;
  sameCwdLabel: string;
  worktreeOptions: Array<{ value: string; label: string }>;
  selectedWorktreePath: string;
  customCwdValue: string;
  newBranchValue: string;
  restoring: boolean;
};

export type RestoreSessionModalHandlers = {
  onClose: () => void;
  onTargetChange: (target: RestoreTargetChoice) => void;
  onWorktreeChange: (path: string) => void;
  onCustomCwdChange: (cwd: string) => void;
  onNewBranchChange: (branch: string) => void;
  onHide: () => void;
  onRestore: () => void;
};

export function renderRestoreSessionModal(
  root: Element,
  model: RestoreSessionModalViewModel | null,
  handlers: RestoreSessionModalHandlers,
): void {
  if (!model) {
    render(null, root);
    return;
  }

  const showWorktreeInput = model.target === "worktree";
  const showCustomCwdInput = model.target === "custom_cwd";
  const showNewBranchInput = model.target === "new_worktree";
  const noWorktreeChoices = showWorktreeInput && model.worktreeOptions.length === 0;
  const disableRestore =
    model.restoring ||
    noWorktreeChoices ||
    (showCustomCwdInput && model.customCwdValue.trim().length === 0);

  render(
    <div
      className="launch-modal-overlay"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) handlers.onClose();
      }}
    >
      <div
        className="launch-modal restore-session-modal"
        tabIndex={-1}
        ref={(el) => { if (el && el !== document.activeElement && !el.contains(document.activeElement)) el.focus(); }}
        onKeyDown={(ev) => {
          if (ev.key === "Escape") {
            ev.preventDefault();
            handlers.onClose();
            return;
          }
          if (ev.key === "Enter" && !disableRestore) {
            ev.preventDefault();
            handlers.onRestore();
          }
        }}
      >
        <h3>Restore session</h3>

        <div className="restore-session-meta">
          <div className="restore-session-title" title={model.sessionTitle}>{model.sessionTitle}</div>
          <div className="restore-session-subtitle" title={model.sessionSubtitle}>{model.sessionSubtitle}</div>
          <div className="restore-session-caption" title={model.providerSessionId}>
            {model.provider}:{model.providerSessionId}
          </div>
        </div>

        <div className="restore-targets">
          <label className="restore-target">
            <input
              type="radio"
              name="restore-target"
              checked={model.target === "same_cwd"}
              onChange={() => handlers.onTargetChange("same_cwd")}
            />
            <span>{model.sameCwdLabel}</span>
          </label>
          <label className="restore-target">
            <input
              type="radio"
              name="restore-target"
              checked={model.target === "worktree"}
              onChange={() => handlers.onTargetChange("worktree")}
            />
            <span>Use an existing worktree</span>
          </label>
          <label className="restore-target">
            <input
              type="radio"
              name="restore-target"
              checked={model.target === "new_worktree"}
              onChange={() => handlers.onTargetChange("new_worktree")}
            />
            <span>Create a new worktree</span>
          </label>
          <label className="restore-target">
            <input
              type="radio"
              name="restore-target"
              checked={model.target === "custom_cwd"}
              onChange={() => handlers.onTargetChange("custom_cwd")}
            />
            <span>Use a custom directory</span>
          </label>
        </div>

        <label className={`launch-modal-label${showWorktreeInput ? "" : " hidden"}`}>
          Worktree
          <select
            className="launch-modal-select"
            disabled={model.worktreeOptions.length === 0}
            value={model.selectedWorktreePath}
            onChange={(ev) => handlers.onWorktreeChange((ev.currentTarget as HTMLSelectElement).value)}
          >
            {model.worktreeOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          {noWorktreeChoices ? <span className="restore-empty-note">No worktrees available for this project.</span> : null}
        </label>

        <label className={`launch-modal-label${showNewBranchInput ? "" : " hidden"}`}>
          Branch name
          <input
            type="text"
            className="launch-modal-input"
            value={model.newBranchValue}
            placeholder="restore-branch-name"
            onInput={(ev) => handlers.onNewBranchChange((ev.currentTarget as HTMLInputElement).value)}
          />
        </label>

        <label className={`launch-modal-label${showCustomCwdInput ? "" : " hidden"}`}>
          Custom directory
          <input
            type="text"
            className="launch-modal-input"
            value={model.customCwdValue}
            placeholder="/path/to/worktree"
            onInput={(ev) => handlers.onCustomCwdChange((ev.currentTarget as HTMLInputElement).value)}
          />
        </label>

        <div className="launch-modal-buttons">
          {model.restoring ? <div className="restore-status" role="status">Restoring inactive session...</div> : null}
          <button
            type="button"
            className="restore-cancel-btn"
            onClick={() => handlers.onClose()}
            disabled={model.restoring}
          >
            Cancel
          </button>
          <button
            type="button"
            className="restore-hide-btn"
            onClick={() => handlers.onHide()}
            disabled={model.restoring}
          >
            Hide
          </button>
          <button
            type="button"
            className={`launch-modal-go${model.restoring ? " restoring" : ""}`}
            disabled={disableRestore}
            onClick={() => handlers.onRestore()}
          >
            {model.restoring ? "Restoring..." : "Restore"}
          </button>
        </div>
      </div>
    </div>,
    root,
  );
}
