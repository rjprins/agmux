import type { PtySummary } from "../types.js";

export type ProviderId = "tmux" | "pty" | "openclaw" | (string & {});

export type ProviderLifecycleAction =
  | "add"
  | "start"
  | "stop"
  | "restart"
  | "attach"
  | "fork"
  | "send"
  | "output"
  | "resize";

export type ProviderCapabilityMap = Record<ProviderLifecycleAction, boolean>;

const PROVIDER_CAPABILITY_DEFAULTS: ProviderCapabilityMap = {
  add: false,
  start: false,
  stop: false,
  restart: false,
  attach: false,
  fork: false,
  send: false,
  output: false,
  resize: false,
};

export function providerCapabilities(
  overrides: Partial<ProviderCapabilityMap>,
): ProviderCapabilityMap {
  return { ...PROVIDER_CAPABILITY_DEFAULTS, ...overrides };
}

export type RuntimeStartRequest = {
  id?: string;
  name?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  metadata?: Record<string, unknown>;
};

export type RuntimeAttachRequest = {
  id?: string;
  name?: string;
  target: string;
  cols?: number;
  rows?: number;
  metadata?: Record<string, unknown>;
};

export type RuntimeStopRequest = {
  id: string;
  force?: boolean;
  metadata?: Record<string, unknown>;
};

export type RuntimeSendRequest = {
  id: string;
  data: string;
};

export type RuntimeResizeRequest = {
  id: string;
  cols: number;
  rows: number;
};

export type RuntimeOutputRequest = {
  id: string;
  maxBytes?: number;
};

export type ReadinessState = "ready" | "busy" | "unknown";
export type SessionState = "running" | "waiting" | "idle" | "error";

export type StatusSnapshot = {
  id: string;
  readiness: ReadinessState;
  sessionState: SessionState;
  reason: string;
  observedAt: number;
  activeProcess: string | null;
  cwd: string | null;
};

export type WorktreeSummary = {
  name: string;
  branch: string;
  path: string;
  head: string | null;
};

export type WorktreeCreateRequest = {
  branch: string;
  fromRef?: string;
  path?: string;
};

export type WorktreeFinishRequest = {
  branch: string;
  mode?: "merge" | "rebase";
};

export type WorktreeCleanupRequest = {
  branch: string;
  force?: boolean;
};

export interface RuntimeProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilityMap;
  start(request: RuntimeStartRequest): Promise<PtySummary>;
  attach(request: RuntimeAttachRequest): Promise<PtySummary>;
  stop(request: RuntimeStopRequest): Promise<void>;
  send(request: RuntimeSendRequest): Promise<void>;
  resize(request: RuntimeResizeRequest): Promise<void>;
  output(request: RuntimeOutputRequest): Promise<string | null>;
}

export interface StatusProvider {
  status(id: string): Promise<StatusSnapshot>;
}

export interface WorktreeProvider {
  listWorktrees(): Promise<WorktreeSummary[]>;
  createWorktree(request: WorktreeCreateRequest): Promise<WorktreeSummary>;
  finishWorktree(request: WorktreeFinishRequest): Promise<void>;
  cleanupWorktree(request: WorktreeCleanupRequest): Promise<void>;
}

export type SessionProvider = RuntimeProvider & StatusProvider & Partial<WorktreeProvider>;
