import { render } from "preact";

export type CloseWorktreeModalViewModel = {
  ptyProcess: string;
  worktreeName: string;
  dirty: boolean | null; // null = still loading
  closing: boolean;
};

export type CloseWorktreeModalHandlers = {
  onClose: () => void;
  onCloseSession: () => void;
  onCloseAndRemove: () => void;
};

export function renderCloseWorktreeModal(
  root: Element,
  model: CloseWorktreeModalViewModel | null,
  handlers: CloseWorktreeModalHandlers,
): void {
  if (!model) {
    render(null, root);
    return;
  }

  const dirtyLoading = model.dirty === null;
  const isDirty = model.dirty === true;

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
        <h3>Close worktree session</h3>

        <p className="close-wt-description">
          <strong>{model.ptyProcess}</strong> is the last session in worktree{" "}
          <strong>{model.worktreeName}</strong>.
        </p>

        {isDirty ? (
          <p className="close-wt-warning">
            This worktree has uncommitted changes. Removing it will discard them.
          </p>
        ) : null}

        <div className="launch-modal-buttons close-wt-buttons">
          <button type="button" onClick={() => handlers.onClose()} disabled={model.closing}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => handlers.onCloseSession()}
            disabled={model.closing}
          >
            Close session
          </button>
          <button
            type="button"
            className={`launch-modal-go${isDirty ? " close-wt-danger" : ""}`}
            disabled={model.closing || dirtyLoading}
            title={isDirty ? "Worktree has uncommitted changes" : "Close session and remove worktree from disk"}
            onClick={() => handlers.onCloseAndRemove()}
          >
            {model.closing
              ? "Closing..."
              : dirtyLoading
                ? "Checking..."
                : isDirty
                  ? "Close + remove (dirty!)"
                  : "Close + remove worktree"}
          </button>
        </div>
      </div>
    </div>,
    root,
  );
}
