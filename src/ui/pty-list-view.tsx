import { Fragment, render } from "preact";

export type ReadyState = "ready" | "busy" | "unknown";
export type ReadyIndicator = "ready" | "busy";

export type RunningPtyItem = {
  id: string;
  color: string;
  active: boolean;
  readyState: ReadyState;
  readyIndicator: ReadyIndicator;
  readyReason: string;
  process: string;
  title?: string;
  secondaryText: string;
  worktree?: string;
  cwd?: string;
  elapsed?: string;
};

export type InactivePtyItem = {
  id: string;
  color: string;
  process: string;
  secondaryText: string;
  secondaryTitle: string;
  worktree?: string;
  cwd?: string;
  elapsed?: string;
  exitLabel: string;
};

export type InactiveGroup = {
  key: string;
  label: string;
  title?: string;
  collapsed: boolean;
  items: InactivePtyItem[];
};

export type WorktreeSubgroup = {
  name: string;
  path: string;
  collapsed: boolean;
  items: RunningPtyItem[];
};

export type PtyGroup = {
  key: string;
  label: string;
  title?: string;
  collapsed: boolean;
  worktrees: WorktreeSubgroup[];
  items: RunningPtyItem[];
};

export type InactiveSection = {
  label: string;
  expanded: boolean;
  total: number;
  groups: InactiveGroup[];
};

export type PtyListModel = {
  groups: PtyGroup[];
  showHeaders: boolean;
  inactive: InactiveSection | null;
};

export type PtyListHandlers = {
  onToggleGroup: (groupKey: string) => void;
  onToggleWorktree: (groupKey: string, worktreeName: string) => void;
  onOpenLaunch: (groupKey: string) => void;
  onSelectPty: (ptyId: string) => void;
  onKillPty: (ptyId: string) => void;
  onResumeInactive: (ptyId: string) => void;
  onToggleInactive: () => void;
  onToggleInactiveGroup: (groupKey: string) => void;
};

function ptyStyle(color: string): Record<string, string> {
  return { "--pty-color": color } as Record<string, string>;
}

function PtyItemRow(
  { item, inWorktree, handlers }: { item: RunningPtyItem; inWorktree: boolean; handlers: PtyListHandlers },
) {
  return (
    <li
      key={item.id}
      className={`pty-item state-${item.readyState}${item.active ? " active" : ""}`}
      data-pty-id={item.id}
      style={ptyStyle(item.color)}
      onClick={() => handlers.onSelectPty(item.id)}
    >
      <div className="row">
        <div className="mainline">
          <div className="primary-row">
            <span className="status-group">
              <span
                className={`ready-dot ${item.readyIndicator}`}
                title={`PTY is ${item.readyState}${item.readyReason ? ` (${item.readyReason})` : ""}`}
                aria-label={`PTY is ${item.readyState}`}
              />
              {item.elapsed
                ? (
                  <span
                    className={`time-badge ${item.readyState === "ready" ? "ready" : "busy"}`}
                    title={item.readyState === "ready" ? `Ready for ${item.elapsed}` : `Processing for ${item.elapsed}`}
                  >
                    {item.elapsed}
                  </span>
                )
                : null}
            </span>
            <div className="primary">{item.process}</div>
            {item.title ? <span className="title-label" title={item.title}>{item.title}</span> : null}
          </div>
          <div className="secondary">
            {!inWorktree && item.worktree
              ? <span className="worktree-badge" title={item.cwd ?? ""}>{item.worktree}</span>
              : null}
            <span>{item.secondaryText}</span>
          </div>
        </div>
        <button
          type="button"
          className="pty-close"
          title="Close"
          aria-label={`Close PTY ${item.process}`}
          onClick={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            handlers.onKillPty(item.id);
          }}
        >
          x
        </button>
      </div>
      <span className={`ready-dot compact ${item.readyIndicator}`} title={`${item.process} - ${item.readyState}`} />
    </li>
  );
}

export function renderPtyList(root: Element, model: PtyListModel, handlers: PtyListHandlers): void {
  render(
    <>
      {model.groups.map((group) => (
        <Fragment key={`group:${group.key}`}>
          {model.showHeaders ? (
            <li
              className={`pty-group-header${group.collapsed ? " collapsed" : ""}`}
              title={group.title}
              onClick={() => handlers.onToggleGroup(group.key)}
            >
              <span className="group-chevron">{group.collapsed ? "\u25b6" : "\u25bc"}</span>
              <span>{group.label}</span>
              <button
                type="button"
                className="group-launch"
                title="Launch agent"
                onClick={(ev) => {
                  ev.stopPropagation();
                  handlers.onOpenLaunch(group.key);
                }}
              >
                +
              </button>
            </li>
          ) : null}

          {group.collapsed
            ? null
            : (
              <>
                {group.items.map((item) => (
                  <PtyItemRow key={item.id} item={item} inWorktree={false} handlers={handlers} />
                ))}

                {group.worktrees.map((wt) => (
                  <Fragment key={`wt:${wt.name}`}>
                    <li
                      className={`worktree-subheader${wt.collapsed ? " collapsed" : ""}`}
                      title={wt.path}
                      onClick={() => handlers.onToggleWorktree(group.key, wt.name)}
                    >
                      <span className="group-chevron">{wt.collapsed ? "\u25b6" : "\u25bc"}</span>
                      <span>{wt.name}</span>
                      <span className="group-count">{wt.items.length}</span>
                    </li>
                    {wt.collapsed
                      ? null
                      : (
                        <div className="worktree-subgroup">
                          {wt.items.map((item) => (
                            <PtyItemRow key={item.id} item={item} inWorktree={true} handlers={handlers} />
                          ))}
                        </div>
                      )}
                  </Fragment>
                ))}
              </>
            )}
        </Fragment>
      ))}

      {model.inactive ? (
        <>
          <li
            className={`pty-group-header${model.inactive.expanded ? "" : " collapsed"}`}
            onClick={() => handlers.onToggleInactive()}
          >
            <span className="group-chevron">{model.inactive.expanded ? "\u25bc" : "\u25b6"}</span>
            <span>{model.inactive.label}</span>
            <span className="group-count">{model.inactive.total}</span>
          </li>

          {model.inactive.expanded
            ? (
              <>
                {model.inactive.groups.map((group) => (
                  <Fragment key={`inactive-group:${group.key}`}>
                    <li
                      className={`worktree-subheader${group.collapsed ? " collapsed" : ""}`}
                      title={group.title}
                      onClick={() => handlers.onToggleInactiveGroup(group.key)}
                    >
                      <span className="group-chevron">{group.collapsed ? "\u25b6" : "\u25bc"}</span>
                      <span>{group.label}</span>
                      <span className="group-count">{group.items.length}</span>
                    </li>
                    {group.collapsed
                      ? null
                      : group.items.map((item) => (
                        <li
                          key={item.id}
                          className="pty-item inactive"
                          data-pty-id={item.id}
                          style={ptyStyle(item.color)}
                          title="Restore session"
                          onClick={() => handlers.onResumeInactive(item.id)}
                        >
                          <div className="row">
                            <div className="mainline">
                              <div className="primary-row">
                                <span className="inactive-dot" title={`Restorable (${item.exitLabel})`} />
                                <div className="primary">{item.process}</div>
                                {item.elapsed ? <span className="time-badge inactive" title={`Inactive for ${item.elapsed}`}>{item.elapsed}</span> : null}
                              </div>
                              <div className="secondary">
                                {item.worktree
                                  ? <span className="worktree-badge" title={item.cwd ?? ""}>{item.worktree}</span>
                                  : null}
                                <span title={item.secondaryTitle}>{item.secondaryText}</span>
                              </div>
                            </div>
                          </div>
                          <span className="inactive-dot compact" title={`Restorable: ${item.process}`} />
                        </li>
                      ))}
                  </Fragment>
                ))}
              </>
            )
            : null}
        </>
      ) : null}
    </>,
    root,
  );
}
