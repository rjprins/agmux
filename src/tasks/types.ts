/** Task status — the universal minimum across all providers. */
export type TaskStatus = "open" | "in-progress" | "closed";

/** Priority levels (0 = highest, 4 = backlog). */
export type TaskPriority = 0 | 1 | 2 | 3 | 4;

/** Dependency / relationship link types. */
export type TaskLinkType = "blocks" | "related" | "parent";

export interface TaskLink {
  type: TaskLinkType;
  targetId: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  links: TaskLink[];
}

export interface TaskInput {
  title: string;
  description?: string;
  /** @default "open" */
  status?: TaskStatus;
  /** @default 2 */
  priority?: TaskPriority;
  links?: TaskLink[];
}

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  priority?: TaskPriority | TaskPriority[];
  /** Only return tasks not blocked by any open task. */
  ready?: boolean;
}

export interface TaskUpdate {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  addLinks?: TaskLink[];
  removeLinks?: TaskLink[];
}

/** Optional capabilities a provider may support beyond the core CRUD. */
export interface TaskProviderCapabilities {
  priorities: boolean;
  links: boolean;
  /** Can compute "ready work" (unblocked tasks). */
  ready: boolean;
}

export interface TaskProvider {
  readonly name: string;
  readonly capabilities: TaskProviderCapabilities;

  create(input: TaskInput): Promise<Task>;
  get(id: string): Promise<Task | null>;
  list(filter?: TaskFilter): Promise<Task[]>;
  update(id: string, changes: TaskUpdate): Promise<Task>;
  delete(id: string): Promise<void>;
  transition(id: string, status: TaskStatus): Promise<Task>;
}

export type TaskProviderType = "beads" | "jira" | "azure-devops";

export interface TaskProviderConfig {
  type: TaskProviderType;
  options?: Record<string, unknown>;
}
