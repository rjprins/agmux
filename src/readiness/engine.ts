import fs from "node:fs/promises";
import type { PtyManager } from "../pty/manager.js";
import type { PtyReadinessIndicator, PtyReadinessState, PtySummary } from "../types.js";
import { tmuxCapturePaneVisible, tmuxPaneActiveProcess, tmuxPaneCurrentPath, tmuxPaneDimensions } from "../tmux.js";
import { inferPaneStatus, type PaneCacheState } from "./status-inference.js";

const READINESS_WORKING_GRACE_MS = Math.max(
  300,
  Number(process.env.AGMUX_WORKING_GRACE_MS ?? "4000") || 4000,
);
const READINESS_RECOMPUTE_DEBOUNCE_MS = 120;
const OUTPUT_BUFFER_LIMIT = 16_000;

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
  ptys: Pick<PtyManager, "getSummary" | "getPid" | "updateCwd">;
  emitReadiness: (evt: PtyReadyEvent) => void;
};

type PtyReadyStateInternal = {
  state: PtyReadinessState;
  indicator: PtyReadinessIndicator;
  reason: string;
  updatedAt: number;
  timer: NodeJS.Timeout | null;
  paneCache: PaneCacheState | undefined;
  outputBuffer: string;
  lastCwd: string | null;
  activeProcess: string | null;
};

type ReadinessEvaluation = {
  state: PtyReadinessState;
  indicator: PtyReadinessIndicator;
  reason: string;
  nextCheckInMs: number | null;
  activeProcess: string | null;
  cwd: string | null;
};

export class ReadinessEngine {
  private readonly readinessByPty = new Map<string, PtyReadyStateInternal>();
  private readonly inputLineByPty = new Map<string, string>();

  constructor(private readonly deps: ReadinessDeps) {}

  markOutput(ptyId: string, chunk: string): void {
    const st = this.ensureReadiness(ptyId);
    st.outputBuffer = mergeOutputBuffer(st.outputBuffer, chunk);
    this.scheduleReadinessRecompute(ptyId, READINESS_RECOMPUTE_DEBOUNCE_MS);
  }

  markInput(ptyId: string, data: string): void {
    const submittedCommand = this.updateInputLineBuffer(ptyId, data);
    if (submittedCommand) {
      this.setPtyReadiness(ptyId, "busy", "input:command");
      this.scheduleReadinessRecompute(ptyId, READINESS_RECOMPUTE_DEBOUNCE_MS);
      return;
    }
    this.scheduleReadinessRecompute(ptyId, READINESS_RECOMPUTE_DEBOUNCE_MS);
  }

  markExited(ptyId: string): void {
    const st = this.ensureReadiness(ptyId);
    this.clearReadinessTimer(st);
    this.inputLineByPty.delete(ptyId);
    st.paneCache = undefined;
    st.outputBuffer = "";
    this.setPtyReadiness(ptyId, "busy", "exited");
  }

  async withActiveProcesses(items: PtySummary[]): Promise<PtySummary[]> {
    return Promise.all(
      items.map(async (p) => {
        const st = this.ensureReadiness(p.id);
        if (p.status !== "running") {
          this.clearReadinessTimer(st);
          this.setPtyReadiness(p.id, "busy", "exited", false);
          return {
            ...p,
            activeProcess: p.activeProcess ?? null,
            ready: false,
            readyState: "busy",
            readyIndicator: "busy",
            readyReason: "exited",
          };
        }

        const evaluation = await this.evaluateReadiness(p.id, p);
        st.activeProcess = evaluation.activeProcess;
        this.setPtyReadiness(p.id, evaluation.state, evaluation.reason, false, evaluation.indicator);
        if (evaluation.nextCheckInMs != null) this.scheduleReadinessRecompute(p.id, evaluation.nextCheckInMs);

        return {
          ...p,
          activeProcess: evaluation.activeProcess,
          cwd: evaluation.cwd,
          ready: st.state === "ready",
          readyState: st.state,
          readyIndicator: st.indicator,
          readyReason: st.reason,
          readyStateChangedAt: st.updatedAt,
        };
      }),
    );
  }

  private async evaluateReadiness(ptyId: string, summary: PtySummary): Promise<ReadinessEvaluation> {
    const st = this.ensureReadiness(ptyId);
    let activeProcess: string | null = summary.activeProcess ?? null;
    let cwd: string | null = summary.cwd ?? null;

    if (summary.backend === "tmux" && summary.tmuxSession) {
      const [proc, liveCwd] = await Promise.all([
        tmuxPaneActiveProcess(summary.tmuxSession),
        tmuxPaneCurrentPath(summary.tmuxSession),
      ]);
      activeProcess = proc;
      if (liveCwd) {
        this.deps.ptys.updateCwd(ptyId, liveCwd);
        cwd = liveCwd;
      }

      const [paneContent, paneSize] = await Promise.all([
        tmuxCapturePaneVisible(summary.tmuxSession),
        tmuxPaneDimensions(summary.tmuxSession),
      ]);
      if (paneContent == null) {
        return {
          state: "unknown",
          indicator: st.indicator,
          reason: "tmux:capture-unavailable",
          nextCheckInMs: null,
          activeProcess,
          cwd,
        };
      }

      const inferred = inferPaneStatus({
        prev: st.paneCache,
        next: {
          content: paneContent,
          width: paneSize?.width ?? 120,
          height: paneSize?.height ?? 30,
        },
        now: Date.now(),
        workingGracePeriodMs: READINESS_WORKING_GRACE_MS,
      });
      st.paneCache = inferred.nextCache;
      return this.mapInferred(inferred.status, inferred.nextCheckInMs, activeProcess, cwd, st.indicator);
    }

    const inferred = inferPaneStatus({
      prev: st.paneCache,
      next: {
        content: st.outputBuffer,
        width: 80,
        height: 24,
      },
      now: Date.now(),
      workingGracePeriodMs: READINESS_WORKING_GRACE_MS,
    });
    st.paneCache = inferred.nextCache;
    return this.mapInferred(inferred.status, inferred.nextCheckInMs, activeProcess, cwd, st.indicator);
  }

  private mapInferred(
    status: "waiting" | "working" | "permission",
    nextCheckInMs: number | null,
    activeProcess: string | null,
    cwd: string | null,
    fallbackIndicator: PtyReadinessIndicator,
  ): ReadinessEvaluation {
    if (status === "working") {
      return {
        state: "busy",
        indicator: "busy",
        reason: "pane:working",
        nextCheckInMs,
        activeProcess,
        cwd,
      };
    }
    if (status === "permission") {
      return {
        state: "ready",
        indicator: "ready",
        reason: "pane:permission",
        nextCheckInMs,
        activeProcess,
        cwd,
      };
    }
    return {
      state: "ready",
      indicator: status === "waiting" ? "ready" : fallbackIndicator,
      reason: "pane:waiting",
      nextCheckInMs,
      activeProcess,
      cwd,
    };
  }

  private ensureReadiness(ptyId: string): PtyReadyStateInternal {
    let st = this.readinessByPty.get(ptyId);
    if (st) return st;
    st = {
      state: "unknown",
      indicator: "busy",
      reason: "startup",
      updatedAt: Date.now(),
      timer: null,
      paneCache: undefined,
      outputBuffer: "",
      lastCwd: null,
      activeProcess: null,
    };
    this.readinessByPty.set(ptyId, st);
    return st;
  }

  private clearReadinessTimer(st: PtyReadyStateInternal): void {
    if (!st.timer) return;
    clearTimeout(st.timer);
    st.timer = null;
  }

  private updateInputLineBuffer(ptyId: string, data: string): boolean {
    let line = this.inputLineByPty.get(ptyId) ?? "";
    let submitted = false;
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        if (line.trim().length > 0) submitted = true;
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
  ): void {
    const st = this.ensureReadiness(ptyId);
    const indicator = state === "ready" ? "ready" : state === "busy" ? "busy" : (indicatorOverride ?? st.indicator);
    const cwd = this.deps.ptys.getSummary(ptyId)?.cwd ?? null;
    const cwdChanged = cwd !== st.lastCwd;
    if (st.state === state && st.reason === reason && st.indicator === indicator && !cwdChanged) return;
    st.state = state;
    st.indicator = indicator;
    st.reason = reason;
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
      activeProcess: st.activeProcess,
    });
  }

  private scheduleReadinessRecompute(ptyId: string, delayMs = READINESS_RECOMPUTE_DEBOUNCE_MS): void {
    const st = this.ensureReadiness(ptyId);
    this.clearReadinessTimer(st);
    st.timer = setTimeout(() => {
      st.timer = null;
      void this.recomputeReadiness(ptyId);
    }, Math.max(20, delayMs));
  }

  private async recomputeReadiness(ptyId: string): Promise<void> {
    const summary = this.deps.ptys.getSummary(ptyId);
    if (!summary || summary.status !== "running") {
      this.setPtyReadiness(ptyId, "busy", "exited");
      return;
    }

    // Keep cwd up to date for non-tmux PTYs.
    if (summary.backend !== "tmux") {
      const pid = this.deps.ptys.getPid(ptyId);
      if (pid) {
        try {
          const liveCwd = await fs.readlink(`/proc/${pid}/cwd`);
          if (liveCwd) this.deps.ptys.updateCwd(ptyId, liveCwd);
        } catch {
          // Process may have exited; ignore.
        }
      }
    }

    const evaluation = await this.evaluateReadiness(ptyId, summary);
    const st = this.ensureReadiness(ptyId);
    st.activeProcess = evaluation.activeProcess;
    this.setPtyReadiness(ptyId, evaluation.state, evaluation.reason, true, evaluation.indicator);
    if (evaluation.nextCheckInMs != null) this.scheduleReadinessRecompute(ptyId, evaluation.nextCheckInMs);
  }

  private readinessSignalSource(reason: string): string {
    if (reason.startsWith("pane:")) return "pane-inference";
    if (reason.startsWith("tmux:")) return "tmux-pane-inspection";
    if (reason.startsWith("input")) return "input-event";
    if (reason === "exited") return "process-exit";
    return "status-engine";
  }
}

function mergeOutputBuffer(current: string, nextChunk: string): string {
  if (!nextChunk) return current;
  const merged = current + nextChunk;
  if (merged.length <= OUTPUT_BUFFER_LIMIT) return merged;
  return merged.slice(-OUTPUT_BUFFER_LIMIT);
}
