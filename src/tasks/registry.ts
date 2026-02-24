import path from "node:path";
import type { SqliteStore } from "../persist/sqlite.js";
import type { TaskProvider, TaskProviderConfig, TaskProviderType } from "./types.js";
import { BeadsProvider } from "./providers/beads.js";

const LEGACY_PREF_KEY = "taskProvider";
const PROJECT_PREF_KEY = "taskProvidersByProject";

type ProviderFactory = (options?: Record<string, unknown>) => TaskProvider;
type TaskProviderMap = Record<string, TaskProviderConfig>;

const factories: Record<TaskProviderType, ProviderFactory> = {
  beads: (opts) => new BeadsProvider(opts),
  jira: () => {
    throw new Error("Jira task provider is not yet implemented");
  },
  "azure-devops": () => {
    throw new Error("Azure DevOps task provider is not yet implemented");
  },
};

const cached = new Map<string, TaskProvider>();

function normalizeProjectRoot(projectRoot: string): string {
  return path.resolve(projectRoot);
}

function readProjectConfigMap(store: SqliteStore): TaskProviderMap {
  const raw = store.getPreference<TaskProviderMap>(PROJECT_PREF_KEY);
  if (!raw || typeof raw !== "object") return {};
  return raw;
}

function writeProjectConfigMap(store: SqliteStore, value: TaskProviderMap): void {
  store.setPreference(PROJECT_PREF_KEY, value);
}

function configCacheKey(config: TaskProviderConfig, projectRoot?: string | null): string {
  const root = projectRoot ? normalizeProjectRoot(projectRoot) : "__global__";
  return `${root}|${JSON.stringify(config)}`;
}

function effectiveOptions(config: TaskProviderConfig, projectRoot?: string | null): Record<string, unknown> | undefined {
  const base = config.options ?? {};
  if (config.type === "beads" && projectRoot) {
    return { ...base, cwd: normalizeProjectRoot(projectRoot) };
  }
  return base;
}

export function createTaskProvider(config: TaskProviderConfig, projectRoot?: string | null): TaskProvider {
  const factory = factories[config.type];
  if (!factory) throw new Error(`unsupported task provider type: ${config.type}`);
  return factory(effectiveOptions(config, projectRoot));
}

export function getTaskProviderConfig(store: SqliteStore, projectRoot?: string | null): TaskProviderConfig | null {
  if (projectRoot) {
    const byProject = readProjectConfigMap(store);
    return byProject[normalizeProjectRoot(projectRoot)] ?? null;
  }
  const legacy = store.getPreference<TaskProviderConfig>(LEGACY_PREF_KEY);
  return legacy?.type ? legacy : null;
}

export function setTaskProviderConfig(store: SqliteStore, projectRoot: string, config: TaskProviderConfig): void {
  const byProject = readProjectConfigMap(store);
  byProject[normalizeProjectRoot(projectRoot)] = config;
  writeProjectConfigMap(store, byProject);
  clearTaskProviderCache(projectRoot);
}

export function clearTaskProviderConfig(store: SqliteStore, projectRoot: string): void {
  const byProject = readProjectConfigMap(store);
  delete byProject[normalizeProjectRoot(projectRoot)];
  writeProjectConfigMap(store, byProject);
  clearTaskProviderCache(projectRoot);
}

export function getTaskProvider(store: SqliteStore, projectRoot?: string | null): TaskProvider | null {
  const config = getTaskProviderConfig(store, projectRoot);
  if (!config?.type) return null;

  const key = configCacheKey(config, projectRoot);
  const existing = cached.get(key);
  if (existing) return existing;

  const provider = createTaskProvider(config, projectRoot);
  cached.set(key, provider);
  return provider;
}

export function clearTaskProviderCache(projectRoot?: string): void {
  if (!projectRoot) {
    cached.clear();
    return;
  }
  const prefix = `${normalizeProjectRoot(projectRoot)}|`;
  for (const key of [...cached.keys()]) {
    if (key.startsWith(prefix)) cached.delete(key);
  }
}
