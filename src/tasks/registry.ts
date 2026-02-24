import type { SqliteStore } from "../persist/sqlite.js";
import type { TaskProvider, TaskProviderConfig, TaskProviderType } from "./types.js";
import { BeadsProvider } from "./providers/beads.js";

const PREF_KEY = "taskProvider";

type ProviderFactory = (options?: Record<string, unknown>) => TaskProvider;

const factories: Record<TaskProviderType, ProviderFactory> = {
  beads: (opts) => new BeadsProvider(opts),
  jira: () => {
    throw new Error("Jira task provider is not yet implemented");
  },
  "azure-devops": () => {
    throw new Error("Azure DevOps task provider is not yet implemented");
  },
};

let cached: { config: TaskProviderConfig; provider: TaskProvider } | null = null;

export function getTaskProvider(store: SqliteStore): TaskProvider | null {
  const config = store.getPreference<TaskProviderConfig>(PREF_KEY);
  if (!config?.type) return null;

  if (cached && cached.config.type === config.type) {
    return cached.provider;
  }

  const factory = factories[config.type];
  if (!factory) return null;

  const provider = factory(config.options);
  cached = { config, provider };
  return provider;
}

export function clearTaskProviderCache(): void {
  cached = null;
}
