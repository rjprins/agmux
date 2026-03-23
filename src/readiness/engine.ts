import type { PtyManager } from "../pty/manager.js";
import type { PtyReadinessIndicator, PtyReadinessState, PtySummary } from "../types.js";

export type AgentReadyProvider = "claude" | "codex";

export type PtyReadyEvent = {
  ptyId: string;
  state: PtyReadinessState;
  indicator: PtyReadinessIndicator;
  reason: string;
  source: string;
  ts: number;
  cwd?: string | null;
  activeProcess?: string | null;
};

type ReadinessDeps = {
  ptys: Pick<PtyManager, "getSummary" | "updateCwd">;
  emitReadiness: (evt: PtyReadyEvent) => void;
};

type PtyReadyStateInternal = {
  state: PtyReadinessState;
  indicator: PtyReadinessIndicator;
  reason: string;
  updatedAt: number;
  provider: AgentReadyProvider | null;
  activeProcess: string | null;
  lastCwd: string | null;
};

export class ReadinessEngine {
  private readonly readinessByPty = new Map<string, PtyReadyStateInternal>();
  private readonly inputLineByPty = new Map<string, string>();

  constructor(private readonly deps: ReadinessDeps) {}

  registerAgent(ptyId: string, provider: AgentReadyProvider): void {
    const st = this.ensureReadiness(ptyId);
    if (st.provider === provider && st.activeProcess === provider) return;
    st.provider = provider;
    st.activeProcess = provider;
  }

  markInput(ptyId: string, data: string): void {
    const submittedCommand = this.updateInputLineBuffer(ptyId, data);
    if (!submittedCommand) return;

    const provider = inferAgentProviderFromCommand(submittedCommand);
    if (provider) this.registerAgent(ptyId, provider);

    const st = this.ensureReadiness(ptyId);
    if (!st.provider) return;
    this.setPtyReadiness(ptyId, "busy", "input:command", true, "busy", undefined, st.provider);
  }

  markReady(ptyId: string, provider: AgentReadyProvider, reason: string): void {
    this.registerAgent(ptyId, provider);
    this.setPtyReadiness(ptyId, "ready", reason, true, "ready", undefined, provider);
  }

  markBusy(ptyId: string, reason: string, provider?: AgentReadyProvider | null): void {
    if (provider) this.registerAgent(ptyId, provider);
    const st = this.ensureReadiness(ptyId);
    if (!st.provider) return;
    this.setPtyReadiness(ptyId, "busy", reason, true, "busy", undefined, st.provider);
  }

  markExited(ptyId: string): void {
    this.inputLineByPty.delete(ptyId);
    this.setPtyReadiness(ptyId, "busy", "exited", true, "busy");
  }

  markCwd(ptyId: string, cwd: string): void {
    this.deps.ptys.updateCwd(ptyId, cwd);
    const st = this.ensureReadiness(ptyId);
    this.setPtyReadiness(ptyId, st.state, st.reason, true, st.indicator, cwd, st.activeProcess);
  }

  withReadiness(items: PtySummary[]): PtySummary[] {
    return items.map((p) => {
      const st = this.ensureReadiness(p.id);
      if (p.status !== "running") {
        this.setPtyReadiness(p.id, "busy", "exited", false, "busy");
        return {
          ...p,
          activeProcess: st.activeProcess,
          ready: false,
          readyState: "busy",
          readyIndicator: "busy",
          readyReason: "exited",
          readyStateChangedAt: st.updatedAt,
        };
      }

      const state = st.state;
      return {
        ...p,
        activeProcess: st.activeProcess ?? p.activeProcess ?? null,
        ready: state === "ready",
        readyState: state,
        readyIndicator: st.indicator,
        readyReason: st.reason,
        readyStateChangedAt: st.updatedAt,
      };
    });
  }

  private ensureReadiness(ptyId: string): PtyReadyStateInternal {
    let st = this.readinessByPty.get(ptyId);
    if (st) return st;
    st = {
      state: "unknown",
      indicator: "busy",
      reason: "startup",
      updatedAt: Date.now(),
      provider: null,
      activeProcess: null,
      lastCwd: null,
    };
    this.readinessByPty.set(ptyId, st);
    return st;
  }

  private updateInputLineBuffer(ptyId: string, data: string): string | null {
    const cleaned = data
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b./g, "");
    let line = this.inputLineByPty.get(ptyId) ?? "";
    let submitted: string | null = null;
    for (const ch of cleaned) {
      if (ch === "\r" || ch === "\n") {
        const trimmed = line.trim();
        if (trimmed.length > 0) submitted = trimmed;
        line = "";
        continue;
      }
      if (ch === "\u0008" || ch === "\u007f") {
        line = line.slice(0, -1);
        continue;
      }
      if (ch === "\u0015") {
        line = "";
        continue;
      }
      if (ch <= "\u001f" || ch === "\u007f") continue;
      line += ch;
      if (line.length > 2000) line = line.slice(-1000);
    }
    this.inputLineByPty.set(ptyId, line);
    return submitted;
  }

  private setPtyReadiness(
    ptyId: string,
    state: PtyReadinessState,
    reason: string,
    emitEvent = true,
    indicatorOverride?: PtyReadinessIndicator,
    cwdOverride?: string | null,
    activeProcessOverride?: string | null,
  ): void {
    const st = this.ensureReadiness(ptyId);
    const indicator = state === "ready" ? "ready" : state === "busy" ? "busy" : (indicatorOverride ?? st.indicator);
    const cwd = cwdOverride ?? this.deps.ptys.getSummary(ptyId)?.cwd ?? null;
    const activeProcess = activeProcessOverride ?? st.activeProcess;
    const cwdChanged = cwd !== st.lastCwd;
    if (
      st.state === state &&
      st.reason === reason &&
      st.indicator === indicator &&
      st.activeProcess === activeProcess &&
      !cwdChanged
    ) return;
    st.state = state;
    st.indicator = indicator;
    st.reason = reason;
    st.activeProcess = activeProcess;
    st.lastCwd = cwd;
    st.updatedAt = Date.now();
    if (!emitEvent) return;
    this.deps.emitReadiness({
      ptyId,
      state,
      indicator,
      reason,
      source: this.readinessSignalSource(reason),
      ts: st.updatedAt,
      cwd,
      activeProcess,
    });
  }

  private readinessSignalSource(reason: string): string {
    if (reason.startsWith("callback:")) return "agent-callback";
    if (reason.startsWith("input:")) return "input-event";
    if (reason === "exited") return "process-exit";
    return "status-engine";
  }
}

function inferAgentProviderFromCommand(command: string): AgentReadyProvider | null {
  const parts = command
    .split(/[|;&]/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of parts) {
    const provider = firstAgentToken(part);
    if (provider) return provider;
  }
  return null;
}

function firstAgentToken(command: string): AgentReadyProvider | null {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  let i = 0;
  while (i < tokens.length) {
    const token = stripQuotes(tokens[i] ?? "");
    if (!token) {
      i += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
      i += 1;
      continue;
    }
    if (token === "env") {
      i += 1;
      continue;
    }
    if (token === "unset") {
      while (i + 1 < tokens.length) {
        const next = stripQuotes(tokens[i + 1] ?? "");
        if (!next || next.startsWith("-")) break;
        i += 1;
      }
      i += 1;
      continue;
    }
    const base = token.split("/").filter(Boolean).at(-1)?.toLowerCase() ?? token.toLowerCase();
    if (base === "claude") return "claude";
    if (base === "codex") return "codex";
    return null;
  }
  return null;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}
