export type PtyId = string;

export type PtyStatus = "running" | "exited";

export type PtySummary = {
  id: PtyId;
  name: string;
  backend?: "pty" | "tmux";
  tmuxSession?: string | null;
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
  | { type: "resize"; ptyId: PtyId; cols: number; rows: number }
  | { type: "tmux_control"; ptyId: PtyId; direction: "up" | "down"; lines: number };

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
  | { type: "pty_highlight"; ptyId: PtyId; reason: string; ttlMs: number }
  | { type: "trigger_error"; ptyId: PtyId; trigger: string; ts: number; message: string };
