import type { PtySummary } from "./types.js";

export const INACTIVE_MAX_AGE_MIN_HOURS = 1;
export const INACTIVE_MAX_AGE_MAX_HOURS = 168; // 7 days
export const DEFAULT_INACTIVE_MAX_AGE_HOURS = 24;

type MergePtyListsOptions = {
  nowMs?: number;
  inactiveMaxAgeHours?: number;
  limit?: number;
};

function clampInactiveMaxAgeHours(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_INACTIVE_MAX_AGE_HOURS;
  const rounded = Math.floor(value as number);
  if (rounded < INACTIVE_MAX_AGE_MIN_HOURS) return INACTIVE_MAX_AGE_MIN_HOURS;
  if (rounded > INACTIVE_MAX_AGE_MAX_HOURS) return INACTIVE_MAX_AGE_MAX_HOURS;
  return rounded;
}

function sessionSortTs(session: PtySummary): number {
  return session.lastSeenAt ?? session.createdAt;
}

/**
 * Merge live PTYs with persisted PTY summaries for UI/API listing.
 *
 * Inactivity tracking model:
 * - "Inactive" means `status !== "running"`.
 * - Recency is `lastSeenAt` when available, otherwise `createdAt`.
 * - Non-running sessions older than `inactiveMaxAgeHours` are dropped.
 * - Live sessions win over persisted rows with the same id.
 * - Persisted `running` rows are normalized to `exited`, because after restart
 *   we cannot assume that an in-memory PTY process still exists.
 */
export function mergePtyLists(
  liveSessions: PtySummary[],
  persistedSessions: PtySummary[],
  options: MergePtyListsOptions = {},
): PtySummary[] {
  const nowMs = options.nowMs ?? Date.now();
  const inactiveMaxAgeHours = clampInactiveMaxAgeHours(options.inactiveMaxAgeHours);
  const inactiveCutoffMs = nowMs - inactiveMaxAgeHours * 60 * 60 * 1000;
  const byId = new Map<string, PtySummary>();

  for (const session of liveSessions) {
    if (session.status !== "running" && sessionSortTs(session) < inactiveCutoffMs) {
      continue;
    }
    byId.set(session.id, session);
  }

  for (const session of persistedSessions) {
    if (byId.has(session.id)) continue;

    const normalized: PtySummary =
      session.status === "running"
        ? {
            ...session,
            status: "exited",
          }
        : session;

    if (sessionSortTs(normalized) < inactiveCutoffMs) continue;
    byId.set(normalized.id, normalized);
  }

  const merged = [...byId.values()].sort((a, b) => sessionSortTs(b) - sessionSortTs(a));

  if (options.limit == null || !Number.isFinite(options.limit) || options.limit <= 0) {
    return merged;
  }
  return merged.slice(0, Math.floor(options.limit));
}
