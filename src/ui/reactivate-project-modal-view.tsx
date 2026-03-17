import { render } from "preact";
import type { RestoreTargetChoice } from "./restore-session-modal-view";

export type ReactivateProjectSessionItem = {
  id: string;
  title: string;
  subtitle: string;
  provider: string;
  providerSessionId: string;
  elapsed?: string;
  worktree?: string;
  firstInput?: string;
  exitLabel: string;
};

export type ReactivateProjectPreviewMessage = {
  role: "user" | "assistant";
  text: string;
};

export type ReactivateProjectModalViewModel = {
  projectLabel: string;
  projectPath?: string;
  sessions: ReactivateProjectSessionItem[];
  selectedSessionId: string;
  previewMessages: ReactivateProjectPreviewMessage[];
  previewLoading: boolean;
  target: RestoreTargetChoice;
  sameCwdLabel: string;
  worktreeOptions: Array<{ value: string; label: string }>;
  selectedWorktreePath: string;
  customCwdValue: string;
  newBranchValue: string;
  restoring: boolean;
};

export type ReactivateProjectModalHandlers = {
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
  onTargetChange: (target: RestoreTargetChoice) => void;
  onWorktreeChange: (path: string) => void;
  onCustomCwdChange: (cwd: string) => void;
  onNewBranchChange: (branch: string) => void;
  onHideSession: () => void;
  onRestore: () => void;
};

export function renderReactivateProjectModal(
  root: Element,
  model: ReactivateProjectModalViewModel | null,
  handlers: ReactivateProjectModalHandlers,
): void {
  if (!model) {
    render(null, root);
    return;
  }

  const selectedSession = model.sessions.find((session) => session.id === model.selectedSessionId) ?? model.sessions[0] ?? null;
  const showWorktreeInput = model.target === "worktree";
  const showCustomCwdInput = model.target === "custom_cwd";
  const showNewBranchInput = model.target === "new_worktree";
  const noWorktreeChoices = showWorktreeInput && model.worktreeOptions.length === 0;
  const disableRestore =
    !selectedSession ||
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
        className="launch-modal reactivate-project-modal"
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
        <div className="reactivate-project-header">
          <div>
            <h3>Reactivate session</h3>
            <div className="reactivate-project-caption" title={model.projectPath ?? model.projectLabel}>
              {model.projectPath ?? model.projectLabel}
            </div>
          </div>
          <div className="reactivate-project-count">{model.sessions.length} available</div>
        </div>

        <div className="reactivate-project-layout">
          <div className="reactivate-project-sessions">
            {model.sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                className={`reactivate-session-item${session.id === selectedSession?.id ? " selected" : ""}`}
                onClick={() => handlers.onSelectSession(session.id)}
              >
                <div className="reactivate-session-top">
                  <span className="reactivate-session-title" title={session.title}>{session.title}</span>
                  {session.elapsed ? <span className="reactivate-session-age">{session.elapsed}</span> : null}
                </div>
                <div className="reactivate-session-meta" title={session.subtitle}>{session.subtitle}</div>
                <div className="reactivate-session-badges">
                  <span>{session.provider}</span>
                  {session.worktree ? <span>{session.worktree}</span> : null}
                  <span>{session.exitLabel}</span>
                </div>
                {session.firstInput ? (
                  <div className="reactivate-session-snippet" title={session.firstInput}>{session.firstInput}</div>
                ) : null}
              </button>
            ))}
          </div>

          <div className="reactivate-project-details">
            {selectedSession ? (
              <>
                <div className="restore-session-meta">
                  <div className="restore-session-title" title={selectedSession.title}>{selectedSession.title}</div>
                  <div className="restore-session-subtitle" title={selectedSession.subtitle}>{selectedSession.subtitle}</div>
                  <div className="restore-session-caption" title={selectedSession.providerSessionId}>
                    {selectedSession.provider}:{selectedSession.providerSessionId}
                  </div>
                </div>

                <div className="reactivate-preview">
                  <div className="reactivate-preview-label">Recent conversation</div>
                  <div className="reactivate-preview-body">
                    {model.previewLoading ? (
                      <div className="session-preview-loading">Loading conversation...</div>
                    ) : model.previewMessages.length === 0 ? (
                      <div className="session-preview-loading">No conversation preview found.</div>
                    ) : (
                      model.previewMessages.map((msg, i) => (
                        <div key={i} className={`session-preview-msg ${msg.role}`}>
                          <div className="msg-role">{msg.role}</div>
                          {msg.text}
                        </div>
                      ))
                    )}
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
              </>
            ) : null}
          </div>
        </div>

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
            onClick={() => handlers.onHideSession()}
            disabled={model.restoring || !selectedSession}
          >
            Hide selected
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
