import { Fragment, render } from "preact";

// Mobile view states:
// - "active": Active sessions list
// - "inactive": Inactive sessions list
// - "session": Single session view
export type MobileView = "active" | "session" | "inactive";

export type MobileRunningSession = {
  id: string;
  process: string;
  subtitle: string;
  worktree?: string;
  cwd?: string;
  readyState: "ready" | "busy" | "unknown";
  readyIndicator: "ready" | "busy";
  readyReason: string;
  elapsed?: string;
  lastInput?: string;
  outputPreview?: string[];
  active: boolean;
};

export type MobileInactiveSession = {
  id: string;
  title: string;
  subtitle: string;
  provider: string;
  worktree?: string;
  elapsed?: string;
};

export type MobileFocus = {
  id: string;
  title: string;
  subtitle: string;
  readyState: "ready" | "busy" | "unknown";
  readyIndicator: "ready" | "busy";
  readyReason: string;
  elapsed?: string;
  lastInput?: string;
};

export type MobileInactivePreview = {
  id: string;
  title: string;
  subtitle: string;
  provider: string;
  providerSessionId: string;
  loading: boolean;
  messages: Array<{ role: "user" | "assistant"; text: string }>;
};

export type MobileViewModel = {
  connected: boolean;
  view: MobileView;
  running: MobileRunningSession[];
  inactive: MobileInactiveSession[];
  focus: MobileFocus | null;
  activeTitle: string;
  inputDraft: string;
  quickPrompts: string[];
  preview: MobileInactivePreview | null;
  settingsOpen: boolean;
  terminalThemeKey: string;
  terminalThemes: Array<{ key: string; name: string }>;
  terminalFontSize: number;
};

export type MobileViewHandlers = {
  onSelectRunning: (ptyId: string) => void;
  onCloseRunning: (ptyId: string) => void;
  onOpenLaunch: () => void;
  onShowInactive: () => void;
  onBack: () => void;
  onChangeDraft: (value: string) => void;
  onSendDraft: () => void;
  onQuickPrompt: (prompt: string) => void;
  onInterrupt: () => void;
  onPreviewInactive: (agentSessionId: string) => void;
  onRestoreInactive: (agentSessionId: string) => void;
  onClosePreview: () => void;
  onTermMountReady: (el: HTMLElement | null) => void;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onTerminalThemeChange: (key: string) => void;
  onTerminalFontSizeChange: (size: number) => void;
};

function renderEmpty(title: string, hint: string) {
  return (
    <div className="mobile-empty">
      <div className="mobile-empty-title">{title}</div>
      <div className="mobile-empty-hint">{hint}</div>
    </div>
  );
}

export function renderMobileView(
  root: Element,
  model: MobileViewModel | null,
  handlers: MobileViewHandlers,
): void {
  if (!model) {
    render(null, root);
    return;
  }

  render(
    <div className={`mobile-shell mobile-view-${model.view}`}>
      <header className="mobile-topbar">
        <div className="mobile-brand">
          <div className="mobile-brand-title">agmux</div>
          <div className="mobile-brand-sub">agent control</div>
        </div>
        <div className="mobile-actions">
          <div className={`mobile-connection ${model.connected ? "ok" : "warn"}`}>
            <span className="conn-dot" />
            {model.connected ? "Live" : "Reconnecting"}
          </div>
          {model.view === "active" ? (
            <button type="button" className="mobile-action" onClick={() => handlers.onShowInactive()}>
              Inactive
            </button>
          ) : (
            <button type="button" className="mobile-action" onClick={() => handlers.onBack()}>
              Back
            </button>
          )}
          <button type="button" className="mobile-action" onClick={() => handlers.onOpenSettings()}>
            Settings
          </button>
          <button type="button" className="mobile-new" onClick={() => handlers.onOpenLaunch()}>
            New
          </button>
        </div>
      </header>

      <div className="mobile-scroll">
        {model.view === "active" ? (
          <section className="mobile-section">
            <div className="mobile-section-title">Active sessions</div>
            {model.running.length === 0 ? (
              renderEmpty("No active sessions", "Start one from the New button.")
            ) : (
              <ul className="mobile-session-list">
                {model.running.map((session, index) => (
                  <li
                    key={session.id}
                    className={`mobile-session-card state-${session.readyState}${session.active ? " active" : ""}`}
                    style={{ "--stagger": `${index * 60}ms` } as Record<string, string>}
                    onClick={() => handlers.onSelectRunning(session.id)}
                  >
                    <div className="session-card-header">
                      <span className={`status-dot ${session.readyIndicator}`} />
                      <div className="session-card-title" title={session.process}>{session.process}</div>
                      {session.elapsed ? <div className="session-card-elapsed">{session.elapsed}</div> : null}
                      <button
                        type="button"
                        className="session-card-close"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          handlers.onCloseRunning(session.id);
                        }}
                      >
                        Close
                      </button>
                    </div>
                    <div className="session-card-sub" title={session.subtitle}>{session.subtitle}</div>
                    {session.outputPreview && session.outputPreview.length > 0 ? (
                      <div className="session-card-output" role="status">
                        {session.outputPreview.map((line, i) => (
                          <div key={`${session.id}-preview-${i}`} className="session-card-output-line">
                            {line || " "}
                          </div>
                        ))}
                      </div>
                    ) : session.lastInput ? (
                      <div className="session-card-input">{session.lastInput}</div>
                    ) : (
                      <div className="session-card-input">No output yet</div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {model.view === "session" ? (
          <Fragment>
            {model.focus ? (
              <section className="mobile-card mobile-focus">
                <div className="focus-header">
                  <span className={`status-dot ${model.focus.readyIndicator}`} />
                  <div className="focus-title" title={model.focus.title}>{model.focus.title}</div>
                  {model.focus.elapsed ? <div className="focus-elapsed">{model.focus.elapsed}</div> : null}
                  <button
                    type="button"
                    className="session-card-close focus-close"
                    onClick={() => handlers.onCloseRunning(model.focus.id)}
                  >
                    Close
                  </button>
                </div>
                <div className="focus-subtitle" title={model.focus.subtitle}>{model.focus.subtitle}</div>
                <div
                  className="focus-xterm-mount"
                  ref={(el: HTMLElement | null) => handlers.onTermMountReady(el)}
                />
                <div className="mobile-composer focus-composer">
                  <textarea
                    rows={3}
                    placeholder="Send a quick directive or question"
                    enterKeyHint="send"
                    value={model.inputDraft}
                    onInput={(ev) => handlers.onChangeDraft((ev.currentTarget as HTMLTextAreaElement).value)}
                    onKeyDown={(ev) => {
                      if (ev.key !== "Enter") return;
                      if (ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey) return;
                      ev.preventDefault();
                      handlers.onSendDraft();
                    }}
                  />
                  <div className="composer-actions">
                    <div className="quick-prompts">
                      {model.quickPrompts.map((prompt) => (
                        <button key={prompt} type="button" onClick={() => handlers.onQuickPrompt(prompt)}>
                          {prompt}
                        </button>
                      ))}
                      <button type="button" className="ghost composer-interrupt" onClick={() => handlers.onInterrupt()}>
                        Interrupt
                      </button>
                    </div>
                    <button
                      type="button"
                      className="mobile-send"
                      onClick={() => handlers.onSendDraft()}
                      disabled={!model.connected}
                    >
                      Send
                    </button>
                  </div>
                </div>
              </section>
            ) : (
              renderEmpty("No active session", "Launch or restore a session to start.")
            )}
          </Fragment>
        ) : null}

        {model.view === "inactive" ? (
          <section className="mobile-section">
            <div className="mobile-section-title">Inactive sessions</div>
            {model.inactive.length === 0 ? (
              renderEmpty("No inactive sessions", "Inactive sessions appear here after they exit.")
            ) : (
              <ul className="mobile-inactive-list">
                {model.inactive.map((session, index) => (
                  <li
                    key={session.id}
                    className="mobile-inactive-card"
                    style={{ "--stagger": `${index * 60}ms` } as Record<string, string>}
                  >
                    <div className="inactive-card-header">
                      <div className="inactive-card-title" title={session.title}>{session.title}</div>
                      {session.elapsed ? <div className="inactive-card-elapsed">{session.elapsed}</div> : null}
                    </div>
                    <div className="inactive-card-sub" title={session.subtitle}>{session.subtitle}</div>
                    <div className="inactive-card-actions">
                      <button type="button" className="ghost" onClick={() => handlers.onPreviewInactive(session.id)}>
                        Preview
                      </button>
                      <button type="button" className="primary" onClick={() => handlers.onRestoreInactive(session.id)}>
                        Activate
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>

      {model.preview ? (
        <div
          className="mobile-sheet"
          onClick={(ev) => {
            if (ev.target === ev.currentTarget) handlers.onClosePreview();
          }}
        >
          <div className="mobile-sheet-panel">
            <div className="sheet-header">
              <div>
                <div className="sheet-title" title={model.preview.title}>{model.preview.title}</div>
                <div className="sheet-sub" title={model.preview.subtitle}>{model.preview.subtitle}</div>
              </div>
              <button type="button" className="ghost" onClick={() => handlers.onClosePreview()}>
                Close
              </button>
            </div>
            <div className="sheet-body">
              {model.preview.loading ? (
                <div className="sheet-loading">Loading conversation...</div>
              ) : model.preview.messages.length === 0 ? (
                <div className="sheet-loading">No messages found.</div>
              ) : (
                model.preview.messages.map((msg, i) => (
                  <div key={`${model.preview.id}-${i}`} className={`sheet-message ${msg.role}`}>
                    <div className="sheet-role">{msg.role}</div>
                    {msg.text}
                  </div>
                ))
              )}
            </div>
            <div className="sheet-actions">
              <button type="button" className="primary" onClick={() => handlers.onRestoreInactive(model.preview.id)}>
                Activate session
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {model.settingsOpen ? (
        <div
          className="mobile-sheet"
          onClick={(ev) => {
            if (ev.target === ev.currentTarget) handlers.onCloseSettings();
          }}
        >
          <div className="mobile-sheet-panel">
            <div className="sheet-header">
              <div>
                <div className="sheet-title">Mobile terminal settings</div>
                <div className="sheet-sub">Applies only to mobile terminal view</div>
              </div>
              <button type="button" className="ghost" onClick={() => handlers.onCloseSettings()}>
                Close
              </button>
            </div>
            <div className="mobile-settings-form">
              <label className="mobile-settings-row">
                <span>Theme</span>
                <select
                  value={model.terminalThemeKey}
                  onChange={(ev) => handlers.onTerminalThemeChange((ev.target as HTMLSelectElement).value)}
                >
                  {model.terminalThemes.map((theme) => (
                    <option key={theme.key} value={theme.key}>
                      {theme.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="mobile-settings-row">
                <span>Font size ({model.terminalFontSize}px)</span>
                <input
                  type="range"
                  min={8}
                  max={22}
                  step={1}
                  value={model.terminalFontSize}
                  onInput={(ev) => handlers.onTerminalFontSizeChange(Number((ev.target as HTMLInputElement).value))}
                />
              </label>
            </div>
          </div>
        </div>
      ) : null}
    </div>,
    root,
  );
}
