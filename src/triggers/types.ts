import type { PtyId, PtySummary } from "../types.js";

export type TriggerScope = "line" | "chunk";

export type TriggerSpawnShellOptions = {
  cwd?: string;
  name?: string;
};

export type TriggerSpawnShellResult = {
  ptyId: PtyId;
  cwd: string | null;
  tmuxSession: string | null;
};

export type TriggerHooks = {
  writeTo: (ptyId: PtyId, data: string) => void;
  listPtys: () => PtySummary[];
  spawnShell: (opts?: TriggerSpawnShellOptions) => Promise<TriggerSpawnShellResult>;
};

export type TriggerCtx = {
  ptyId: PtyId;
  ts: number;
  match: RegExpMatchArray;
  line: string;
  emit: (evt: unknown) => void;
  write: (data: string) => void;
  hooks: TriggerHooks;
};

export type Trigger = {
  name: string;
  scope?: TriggerScope; // default: line
  pattern: RegExp;
  cooldownMs?: number;
  onMatch: (ctx: TriggerCtx) => void | Promise<void>;
};

export type TriggerModule = {
  triggers: Trigger[];
};
