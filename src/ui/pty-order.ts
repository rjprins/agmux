import type { PtySummary } from "../shared/protocol.js";

function sidebarBasename(input: string): string {
  const segments = input.split("/").filter(Boolean);
  return segments.at(-1) ?? input;
}

export function compareSidebarGroupKeys(a: string, b: string): number {
  if (!a) return 1;
  if (!b) return -1;
  return sidebarBasename(a).localeCompare(sidebarBasename(b));
}

export function orderRunningPtysForSidebar(
  ptys: PtySummary[],
  opts: {
    pinnedDirectories: ReadonlySet<string>;
    getGroupKey: (pty: PtySummary) => string;
  },
): PtySummary[] {
  const runningByDir = new Map<string, PtySummary[]>();
  for (const pty of ptys) {
    if (pty.status !== "running") continue;
    const key = opts.getGroupKey(pty);
    const items = runningByDir.get(key);
    if (items) {
      items.push(pty);
    } else {
      runningByDir.set(key, [pty]);
    }
  }

  const orderedKeys = [
    ...[...runningByDir.keys()].filter((key) => opts.pinnedDirectories.has(key)).sort(compareSidebarGroupKeys),
    ...[...runningByDir.keys()].filter((key) => !opts.pinnedDirectories.has(key)).sort(compareSidebarGroupKeys),
  ];

  return orderedKeys.flatMap((key) => runningByDir.get(key) ?? []);
}
