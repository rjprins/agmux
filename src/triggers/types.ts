import type { PtyId } from "../types.js";

export type TriggerScope = "line" | "chunk";

export type TriggerCtx = {
  ptyId: PtyId;
  ts: number;
  match: RegExpMatchArray;
  line: string;
  emit: (evt: unknown) => void;
  write: (data: string) => void;
};

export type Trigger = {
  name: string;
  scope?: TriggerScope; // default: line
  pattern: RegExp;
  cooldownMs?: number;
  onMatch: (ctx: TriggerCtx) => void;
};

export type TriggerModule = {
  triggers: Trigger[];
};

