import { Fragment, render } from "preact";

const PAGE_SIZE = 8;
const visiblePages = new Map<string, number>();

function getVisibleCount(key: string): number {
  return (visiblePages.get(key) ?? 1) * PAGE_SIZE;
}

function showMore(key: string): void {
  visiblePages.set(key, (visiblePages.get(key) ?? 1) + 1);
}

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
  total: number;
  items: InactivePtyItem[];
  worktrees: InactiveWorktreeSubgroup[];
  archived?: boolean;
};

export type InactiveWorktreeSubgroup = {
  name: string;
  path: string;
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
  pinned: boolean;
  collapsed: boolean;
  worktrees: WorktreeSubgroup[];
  items: RunningPtyItem[];
  inactiveSessions: InactivePtyItem[];
  inactiveWorktrees: InactiveWorktreeSubgroup[];
  inactiveTotal: number;
  inlineInactiveExpanded: boolean;
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
  archived: InactiveSection | null;
};

export type PtyListHandlers = {
  onToggleGroup: (groupKey: string) => void;
  onToggleWorktree: (groupKey: string, worktreeName: string) => void;
  onTogglePin: (groupKey: string) => void;
  onToggleInlineInactive: (groupKey: string) => void;
  onOpenLaunch: (groupKey: string) => void;
  onOpenLaunchInWorktree: (groupKey: string, worktreePath: string) => void;
  onSelectPty: (ptyId: string) => void;
  onKillPty: (ptyId: string) => void;
  onResumeInactive: (ptyId: string) => void;
  onInactiveActions: (ptyId: string) => void;
  onToggleInactive: () => void;
  onToggleInactiveGroup: (groupKey: string) => void;
  onToggleInactiveWorktree: (groupKey: string, worktreeName: string) => void;
  onArchive: (groupKey: string) => void;
  onUnarchive: (groupKey: string) => void;
  onToggleArchived: () => void;
  onToggleArchivedGroup: (groupKey: string) => void;
  onToggleArchivedWorktree: (groupKey: string, worktreeName: string) => void;
  onShowMore: (contextKey: string) => void;
};

function InactiveItemRow(
  { item, inWorktree, handlers }: { item: InactivePtyItem; inWorktree: boolean; handlers: PtyListHandlers },
) {
  const tooltipParts = [item.secondaryText, item.secondaryTitle].filter(Boolean);
  const tooltip = tooltipParts.join("\n");
  return (
    <li
      key={item.id}
      className="pty-item inactive compact"
      data-pty-id={item.id}
      style={ptyStyle(item.color)}
      title={tooltip}
      onClick={() => handlers.onResumeInactive(item.id)}
    >
      <div className="row">
        <div className="mainline">
          <div className="primary-row">
            <span className="inactive-dot" title={`Restorable (${item.exitLabel})`} />
            {!inWorktree && item.worktree
              ? <span className="worktree-badge" title={item.cwd ?? ""}>{item.worktree}</span>
              : null}
            <div className="primary">{item.process}</div>
            {item.elapsed ? <span className="time-badge inactive" title={`Inactive for ${item.elapsed}`}>{item.elapsed}</span> : null}
          </div>
        </div>
        <button
          type="button"
          className="pty-close pty-actions pty-actions-arrow"
          title="Restore options"
          aria-label={`Restore options for ${item.process}`}
          onClick={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            handlers.onInactiveActions(item.id);
          }}
        >
          {">"}
        </button>
      </div>
      <span className="inactive-dot compact" title={`Restorable: ${item.process}`} />
    </li>
  );
}

function TruncatedInactiveList(
  { contextKey, items, inWorktree, handlers }: {
    contextKey: string;
    items: InactivePtyItem[];
    inWorktree: boolean;
    handlers: PtyListHandlers;
  },
) {
  if (items.length === 0) return null;
  const limit = getVisibleCount(contextKey);
  const visible = items.slice(0, limit);
  const remaining = items.length - visible.length;
  return (
    <>
      {visible.map((item) => (
        <InactiveItemRow key={item.id} item={item} inWorktree={inWorktree} handlers={handlers} />
      ))}
      {remaining > 0 ? (
        <li
          className="pty-item inactive compact show-more"
          onClick={(ev) => {
            ev.stopPropagation();
            showMore(contextKey);
            handlers.onShowMore(contextKey);
          }}
        >
          <span className="show-more-label">… {remaining} more</span>
        </li>
      ) : null}
    </>
  );
}

function ptyStyle(color: string): Record<string, string> {
  return { "--pty-color": color } as Record<string, string>;
}

function PtyItemRow(
  { item, handlers }: { item: RunningPtyItem; handlers: PtyListHandlers },
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
          {(item.worktree || item.secondaryText) ? (
            <div className="secondary">
              {item.worktree ? (
                <span className="worktree-badge" title={item.cwd ?? ""}>{item.worktree}</span>
              ) : null}
              {item.secondaryText ? (
                <span className="secondary-text">{item.secondaryText}</span>
              ) : null}
            </div>
          ) : null}
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
  const hasRunning = (group: PtyGroup) => group.items.length > 0;
  render(
    <>
      {model.groups.map((group) => (
        <Fragment key={`group:${group.key}`}>
          {model.showHeaders ? (
            <li
              className={`pty-group-header${group.collapsed ? " collapsed" : ""}${group.pinned && !hasRunning(group) ? " pinned-empty" : ""}`}
              title={group.title}
              onClick={() => handlers.onToggleGroup(group.key)}
            >
              <span className="group-chevron">{group.collapsed ? "\u25b6" : "\u25bc"}</span>
              <span>{group.label}</span>
              <button
                type="button"
                className="group-action-btn"
                title={group.pinned ? "Unpin" : "Pin"}
                onClick={(ev) => {
                  ev.stopPropagation();
                  handlers.onTogglePin(group.key);
                }}
              >
                {group.pinned ? "\u2605" : "\u2606"}
              </button>
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
              <div className={model.showHeaders ? "group-body" : undefined}>
                {group.items.map((item) => (
                  <PtyItemRow key={item.id} item={item} handlers={handlers} />
                ))}

                {group.inactiveTotal > 0 && hasRunning(group) ? (
                  <>
                    <li
                      className={`inline-inactive-divider${group.inlineInactiveExpanded ? "" : " collapsed"}`}
                      onClick={() => handlers.onToggleInlineInactive(group.key)}
                    >
                      <span className="group-chevron">{group.inlineInactiveExpanded ? "\u25bc" : "\u25b6"}</span>
                      <span>Inactive</span>
                      <span className="group-count">{group.inactiveTotal}</span>
                    </li>
                    {group.inlineInactiveExpanded ? (
                      <>
                        <TruncatedInactiveList contextKey={`inline:${group.key}`} items={group.inactiveSessions} inWorktree={false} handlers={handlers} />
                        {group.inactiveWorktrees.map((wt) => (
                          <Fragment key={`inline-iwt:${group.key}::${wt.name}`}>
                            <li
                              className={`worktree-subheader${wt.collapsed ? " collapsed" : ""}`}
                              title={wt.path}
                              onClick={() => handlers.onToggleInactiveWorktree(group.key, wt.name)}
                            >
                              <span className="group-chevron">{wt.collapsed ? "\u25b6" : "\u25bc"}</span>
                              <span>{wt.name}</span>
                              <button
                                type="button"
                                className="worktree-launch"
                                title="Launch agent in this worktree"
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  handlers.onOpenLaunchInWorktree(group.key, wt.path);
                                }}
                              >
                                +
                              </button>
                            </li>
                            {wt.collapsed
                              ? null
                              : <TruncatedInactiveList contextKey={`inline-wt:${group.key}::${wt.name}`} items={wt.items} inWorktree={true} handlers={handlers} />}
                          </Fragment>
                        ))}
                      </>
                    ) : null}
                  </>
                ) : null}

                {group.inactiveTotal > 0 && !hasRunning(group) ? (
                  <>
                    <TruncatedInactiveList contextKey={`norun:${group.key}`} items={group.inactiveSessions} inWorktree={false} handlers={handlers} />
                    {group.inactiveWorktrees.map((wt) => (
                      <Fragment key={`inline-iwt:${group.key}::${wt.name}`}>
                        <li
                          className={`worktree-subheader${wt.collapsed ? " collapsed" : ""}`}
                          title={wt.path}
                          onClick={() => handlers.onToggleInactiveWorktree(group.key, wt.name)}
                        >
                          <span className="group-chevron">{wt.collapsed ? "\u25b6" : "\u25bc"}</span>
                          <span>{wt.name}</span>
                          <span className="group-count">{wt.items.length}</span>
                        </li>
                        {wt.collapsed
                          ? null
                          : <TruncatedInactiveList contextKey={`norun-wt:${group.key}::${wt.name}`} items={wt.items} inWorktree={true} handlers={handlers} />}
                      </Fragment>
                    ))}
                  </>
                ) : null}
              </div>
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
                      <button
                        type="button"
                        className="group-action-btn"
                        title="Pin"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          handlers.onTogglePin(group.key);
                        }}
                      >
                        {"\u2606"}
                      </button>
                      <button
                        type="button"
                        className="group-action-btn"
                        title="Archive"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          handlers.onArchive(group.key);
                        }}
                      >
                        {"\u2193"}
                      </button>
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
                    {group.collapsed
                      ? null
                      : (
                        <div className="group-body">
                          <TruncatedInactiveList contextKey={`orphan:${group.key}`} items={group.items} inWorktree={false} handlers={handlers} />
                          {group.worktrees.map((wt) => (
                            <Fragment key={`inactive-wt:${group.key}::${wt.name}`}>
                              <li
                                className={`worktree-subheader${wt.collapsed ? " collapsed" : ""}`}
                                title={wt.path}
                                onClick={() => handlers.onToggleInactiveWorktree(group.key, wt.name)}
                              >
                                <span className="group-chevron">{wt.collapsed ? "\u25b6" : "\u25bc"}</span>
                                <span>{wt.name}</span>
                                <button
                                  type="button"
                                  className="worktree-launch"
                                  title="Launch agent in this worktree"
                                  onClick={(ev) => {
                                    ev.stopPropagation();
                                    handlers.onOpenLaunchInWorktree(group.key, wt.path);
                                  }}
                                >
                                  +
                                </button>
                              </li>
                              {wt.collapsed
                                ? null
                                : <TruncatedInactiveList contextKey={`orphan-wt:${group.key}::${wt.name}`} items={wt.items} inWorktree={true} handlers={handlers} />}
                            </Fragment>
                          ))}
                        </div>
                      )}
                  </Fragment>
                ))}
              </>
            )
            : null}
        </>
      ) : null}

      {model.archived ? (
        <>
          <li
            className={`pty-group-header${model.archived.expanded ? "" : " collapsed"}`}
            onClick={() => handlers.onToggleArchived()}
          >
            <span className="group-chevron">{model.archived.expanded ? "\u25bc" : "\u25b6"}</span>
            <span>{model.archived.label}</span>
            <span className="group-count">{model.archived.total}</span>
          </li>

          {model.archived.expanded
            ? (
              <>
                {model.archived.groups.map((group) => (
                  <Fragment key={`archived-group:${group.key}`}>
                    <li
                      className={`worktree-subheader${group.collapsed ? " collapsed" : ""}`}
                      title={group.title}
                      onClick={() => handlers.onToggleArchivedGroup(group.key)}
                    >
                      <span className="group-chevron">{group.collapsed ? "\u25b6" : "\u25bc"}</span>
                      <span>{group.label}</span>
                      <button
                        type="button"
                        className="group-action-btn"
                        title="Unarchive"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          handlers.onUnarchive(group.key);
                        }}
                      >
                        {"\u2191"}
                      </button>
                      <button
                        type="button"
                        className="group-launch"
                        title="Launch agent (unarchives project)"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          handlers.onOpenLaunch(group.key);
                        }}
                      >
                        +
                      </button>
                    </li>
                    {group.collapsed
                      ? null
                      : (
                        <div className="group-body">
                          <TruncatedInactiveList contextKey={`archived:${group.key}`} items={group.items} inWorktree={false} handlers={handlers} />
                          {group.worktrees.map((wt) => (
                            <Fragment key={`archived-wt:${group.key}::${wt.name}`}>
                              <li
                                className={`worktree-subheader${wt.collapsed ? " collapsed" : ""}`}
                                title={wt.path}
                                onClick={() => handlers.onToggleArchivedWorktree(group.key, wt.name)}
                              >
                                <span className="group-chevron">{wt.collapsed ? "\u25b6" : "\u25bc"}</span>
                                <span>{wt.name}</span>
                              </li>
                              {wt.collapsed
                                ? null
                                : <TruncatedInactiveList contextKey={`archived-wt:${group.key}::${wt.name}`} items={wt.items} inWorktree={true} handlers={handlers} />}
                            </Fragment>
                          ))}
                        </div>
                      )}
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
