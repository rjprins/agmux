export type PtyId = string;

export type PtyStatus = "running" | "exited";

export type PtySummary = {
  id: PtyId;
  name: string;
  command: string;
  args: string[];
  cwd: string | null;
  createdAt: number;
  status: PtyStatus;
  exitCode?: number | null;
  exitSignal?: string | null;
};

export type ClientToServerMessage =
  | { type: "subscribe"; ptyId: PtyId }
  | { type: "input"; ptyId: PtyId; data: string }
  | { type: "resize"; ptyId: PtyId; cols: number; rows: number };

export type ServerToClientMessage =
  | { type: "pty_list"; ptys: PtySummary[] }
  | { type: "pty_output"; ptyId: PtyId; data: string }
  | { type: "pty_exit"; ptyId: PtyId; code: number | null; signal: string | null }
  | {
      type: "trigger_fired";
      ptyId: PtyId;
      trigger: string;
      match: string;
      line: string;
      ts: number;
    }
  | { type: "pty_highlight"; ptyId: PtyId; reason: string; ttlMs: number };

