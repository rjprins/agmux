import fs from "node:fs/promises";
import stripAnsi from "strip-ansi";
import type { PtyManager } from "../pty/manager.js";
import {
  detectAgentOutputSignal,
  mergeAgentOutputTail,
  outputShowsAgentPromptMarker,
  type AgentFamily,
} from "./markers.js";
import type { PtyReadinessIndicator, PtyReadinessState, PtySummary } from "../types.js";
import { tmuxCapturePaneVisible, tmuxPaneActiveProcess, tmuxPaneCurrentPath } from "../tmux.js";

const READINESS_QUIET_MS = 220;
const READINESS_PROMPT_WINDOW_MS = 15_000;
const READINESS_BUSY_DELAY_MS = 120;
const READINESS_AGENT_UNKNOWN_TO_READY_MS = 1_200;
const LOG_STATE_TTL_MS = 10_000;
const SHELL_PROCESS_NAMES = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu"]);
const AGENT_PROCESS_NAMES = new Set(["codex", "claude", "aider", "goose", "opencode", "cursor-agent"]);

type SessionMode = "shell" | "agent" | "other";

type PtyReadyState = {
  state: PtyReadinessState;
  indicator: PtyReadinessIndicator;
  reason: string;
  updatedAt: number;
  lastOutputAt: number;
  lastPromptAt: number;
  recentAgentOutputTail: string;
  timer: NodeJS.Timeout | null;
  busyDelayTimer: NodeJS.Timeout | null;
  modeHint: SessionMode | null;
  agentFamilyHint: AgentFamily | null;
  lastCwd: string | null;
  logState: PtyReadinessState | null;
  logReason: string | null;
  logUpdatedAt: number;
};

export type PtyReadyEvent = {
  ptyId: string;
  state: PtyReadinessState;
  indicator: PtyReadinessIndicator;
  reason: string;
  source: string;
  ts: number;
  cwd?: string | null;
};

type ReadinessDeps = {
  ptys: Pick<PtyManager, "getSummary" | "getPid" | "updateCwd">;
  emitReadiness: (evt: PtyReadyEvent) => void;
};

export class ReadinessEngine {
  private readonly readinessByPty = new Map<string, PtyReadyState>();
  private readonly inputLineByPty = new Map<string, string>();

  constructor(private readonly deps: ReadinessDeps) {}

  markOutput(ptyId: string, chunk: string): void {
    const st = this.ensureReadiness(ptyId);
    const summary = this.deps.ptys.getSummary(ptyId);
    const now = Date.now();
    const classifiedMode = this.classifySessionMode(summary, summary?.activeProcess ?? null);
    const agentSignalWindow = mergeAgentOutputTail(st.recentAgentOutputTail, chunk);
    let mode = this.effectiveSessionMode(st, summary, classifiedMode, now);
    let agentFamily =
      mode === "agent" ? (this.detectAgentFamily(summary, summary?.activeProcess ?? null) ?? st.agentFamilyHint) : null;
    const inferredFromOutput = this.inferAgentFamilyFromOutput(agentSignalWindow);
    if (mode !== "agent" && inferredFromOutput) {
      mode = "agent";
      st.modeHint = "agent";
      agentFamily = inferredFromOutput;
    } else if (mode !== "other") {
      st.modeHint = mode;
    }
    if (agentFamily) st.agentFamilyHint = agentFamily;
    st.recentAgentOutputTail = mode === "agent" ? agentSignalWindow : "";

    // If log state is fresh, keep terminal tracking warm but skip readiness state changes.
    if (st.logState !== null && Date.now() - st.logUpdatedAt < LOG_STATE_TTL_MS) {
      st.lastOutputAt = now;
      return;
    }

    const agentSignal = mode === "agent" ? detectAgentOutputSignal(agentSignalWindow, agentFamily) : "none";
    if (agentSignal === "busy") {
      this.clearBusyDelayTimer(st);
      st.lastOutputAt = now;
      st.lastPromptAt = 0;
      this.setPtyReadiness(ptyId, "busy", `agent:busy-marker${agentFamily ? `:${agentFamily}` : ""}`);
      this.scheduleReadinessRecompute(ptyId);
      return;
    }
    if (agentSignal === "prompt") {
      this.clearBusyDelayTimer(st);
      st.lastOutputAt = now;
      st.lastPromptAt = now;
      this.setAgentUnknownOrReady(ptyId, st, now, `agent:prompt-marker${agentFamily ? `:${agentFamily}` : ""}`);
      return;
    }
    const promptLike = this.outputLooksLikePrompt(chunk);
    if (!promptLike && !this.outputHasVisibleText(chunk)) return;
    st.lastOutputAt = now;
    if (mode === "agent") {
      const promptFreshForPromotion =
        st.lastPromptAt > 0 && now - st.lastPromptAt <= READINESS_AGENT_UNKNOWN_TO_READY_MS + READINESS_BUSY_DELAY_MS;
      if (promptFreshForPromotion) {
        this.setAgentUnknownOrReady(ptyId, st, now, "agent:prompt-pending");
        return;
      }
      st.lastPromptAt = 0;
      if (st.state === "ready" || st.state === "unknown") this.scheduleBusyDelay(ptyId, "agent:output");
      else this.setPtyReadiness(ptyId, "busy", "agent:output");
      this.scheduleReadinessRecompute(ptyId);
      return;
    }
    if (promptLike) {
      this.clearBusyDelayTimer(st);
      st.lastPromptAt = now;
      this.setPtyReadiness(ptyId, "ready", "prompt");
      this.scheduleReadinessRecompute(ptyId);
      return;
    }
    if (st.state === "ready" || st.state === "unknown") this.scheduleBusyDelay(ptyId, "output");
    else this.setPtyReadiness(ptyId, "busy", "output");
    this.scheduleReadinessRecompute(ptyId);
  }

  markInput(ptyId: string, data: string): void {
    const st = this.ensureReadiness(ptyId);
    this.clearBusyDelayTimer(st);
    st.lastOutputAt = Date.now();
    const submittedCommand = this.updateInputLineBuffer(ptyId, data);
    st.lastPromptAt = 0;
    if (submittedCommand) st.recentAgentOutputTail = "";
    if (submittedCommand) {
      this.scheduleBusyDelay(ptyId, "input:command");
      this.scheduleReadinessRecompute(ptyId);
      return;
    }
    if (st.state !== "ready") this.setPtyReadiness(ptyId, "busy", "input");
    this.scheduleReadinessRecompute(ptyId);
  }

  markExited(ptyId: string): void {
    const st = this.ensureReadiness(ptyId);
    this.clearReadinessTimer(st);
    this.clearBusyDelayTimer(st);
    this.inputLineByPty.delete(ptyId);
    st.recentAgentOutputTail = "";
    this.setPtyReadiness(ptyId, "busy", "exited");
  }

  markLogState(ptyId: string, state: PtyReadinessState, reason: string): void {
    const st = this.ensureReadiness(ptyId);
    st.logState = state;
    st.logReason = reason;
    st.logUpdatedAt = Date.now();
    this.setPtyReadiness(ptyId, state, reason);
  }

  clearLogState(ptyId: string): void {
    const st = this.ensureReadiness(ptyId);
    st.logState = null;
    st.logReason = null;
    st.logUpdatedAt = 0;
  }

  getAgentFamily(ptyId: string): AgentFamily | null {
    return this.ensureReadiness(ptyId).agentFamilyHint;
  }

  async withActiveProcesses(items: PtySummary[]): Promise<PtySummary[]> {
    return Promise.all(
      items.map(async (p) => {
        const st = this.ensureReadiness(p.id);
        if (p.status !== "running") {
          this.clearReadinessTimer(st);
          this.clearBusyDelayTimer(st);
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

        const isTmux = p.backend === "tmux" && p.tmuxSession;
        const [activeProcess, liveCwd] = isTmux
          ? await Promise.all([tmuxPaneActiveProcess(p.tmuxSession!), tmuxPaneCurrentPath(p.tmuxSession!)])
          : [null, null];
        const effectiveCwd = liveCwd ?? p.cwd;
        const now = Date.now();
        const mode = this.classifySessionMode(p, activeProcess);
        const effectiveMode = this.effectiveSessionMode(st, p, mode, now);
        const agentFamily = effectiveMode === "agent" ? (this.detectAgentFamily(p, activeProcess) ?? st.agentFamilyHint) : null;
        st.modeHint = effectiveMode;
        st.agentFamilyHint = agentFamily;
        const promptFresh = st.lastPromptAt > 0 && now - st.lastPromptAt <= READINESS_PROMPT_WINDOW_MS;

        if (promptFresh) {
          if (effectiveMode === "agent") {
            const decision = this.agentUnknownDecision(st, now, "agent:prompt-stable");
            this.setPtyReadiness(p.id, decision.state, decision.reason, false);
          } else {
            this.setPtyReadiness(p.id, "ready", "prompt", false);
          }
        } else if (p.backend === "tmux" && p.tmuxSession && activeProcess && !this.isShellProcess(activeProcess)) {
          if (await this.tmuxSessionShowsPrompt(p.id, p.tmuxSession, effectiveMode, agentFamily)) {
            if (effectiveMode === "agent") {
              const decision = this.agentUnknownDecision(st, now, "agent:prompt-visible");
              this.setPtyReadiness(p.id, decision.state, decision.reason, false);
            } else {
              this.setPtyReadiness(p.id, "ready", "prompt-visible", false);
            }
          } else {
            this.setPtyReadiness(p.id, "busy", `process:${this.normalizeProcessName(activeProcess)}`, false);
          }
        } else if (p.backend === "tmux" && p.tmuxSession && !activeProcess) {
          if (await this.tmuxSessionShowsPrompt(p.id, p.tmuxSession, effectiveMode, agentFamily)) {
            if (effectiveMode === "agent") {
              const decision = this.agentUnknownDecision(st, now, "agent:prompt-visible");
              this.setPtyReadiness(p.id, decision.state, decision.reason, false);
            } else {
              this.setPtyReadiness(p.id, "ready", "prompt-visible", false);
            }
          } else {
            this.setPtyReadiness(p.id, "unknown", "tmux:process-unresolved", false);
          }
        } else if (p.backend === "tmux") {
          if (effectiveMode === "agent") {
            const decision = this.agentUnknownDecision(st, now, "agent:idle-shell");
            this.setPtyReadiness(p.id, decision.state, decision.reason, false);
          } else {
            this.setPtyReadiness(p.id, "ready", "idle-shell", false);
          }
        } else if (effectiveMode === "agent") {
          const decision = this.agentUnknownDecision(st, now, "agent:idle");
          this.setPtyReadiness(p.id, decision.state, decision.reason, false);
        } else {
          this.setPtyReadiness(p.id, "unknown", "unknown", false);
        }

        return {
          ...p,
          activeProcess,
          cwd: effectiveCwd,
          ready: st.state === "ready",
          readyState: st.state,
          readyIndicator: st.indicator,
          readyReason: st.reason,
          readyStateChangedAt: st.updatedAt,
        };
      }),
    );
  }

  private normalizeProcessName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return "";
    return (trimmed.split("/").filter(Boolean).at(-1) ?? trimmed).toLowerCase();
  }

  private isShellProcess(name: string): boolean {
    return SHELL_PROCESS_NAMES.has(this.normalizeProcessName(name));
  }

  private isAgentProcess(name: string): boolean {
    const normalized = this.normalizeProcessName(name);
    if (!normalized) return false;
    if (AGENT_PROCESS_NAMES.has(normalized)) return true;
    return normalized.startsWith("codex") || normalized.startsWith("claude");
  }

  private agentFamilyFromProcessName(name: string | null | undefined): AgentFamily | null {
    if (!name) return null;
    const normalized = this.normalizeProcessName(name);
    if (!normalized) return null;
    if (normalized.startsWith("codex")) return "codex";
    if (normalized.startsWith("claude")) return "claude";
    if (AGENT_PROCESS_NAMES.has(normalized)) return "other";
    return null;
  }

  private detectAgentFamily(summary: PtySummary | null, activeProcess: string | null): AgentFamily | null {
    return (
      this.agentFamilyFromProcessName(activeProcess) ??
      this.agentFamilyFromProcessName(summary?.activeProcess ?? null) ??
      this.agentFamilyFromProcessName(summary?.command ?? null)
    );
  }

  private inferAgentFamilyFromOutput(chunk: string): AgentFamily | null {
    if (outputShowsAgentPromptMarker(chunk, "codex")) return "codex";
    if (outputShowsAgentPromptMarker(chunk, "claude")) return "claude";
    const codexBusy = detectAgentOutputSignal(chunk, "codex") === "busy";
    if (codexBusy) return "codex";
    const claudeBusy = detectAgentOutputSignal(chunk, "claude") === "busy";
    if (claudeBusy) return "claude";
    return detectAgentOutputSignal(chunk, null) !== "none" ? "other" : null;
  }

  private classifySessionMode(summary: PtySummary | null, activeProcess: string | null): SessionMode {
    if (activeProcess && this.isAgentProcess(activeProcess)) return "agent";
    if (summary?.command && this.isAgentProcess(summary.command)) return "agent";
    if (summary?.name?.startsWith("shell:")) return "shell";
    if (summary?.command && this.isShellProcess(summary.command)) return "shell";
    if (activeProcess && this.isShellProcess(activeProcess)) return "shell";
    return "other";
  }

  private effectiveSessionMode(
    st: PtyReadyState,
    summary: PtySummary | null,
    classifiedMode: SessionMode,
    now: number,
  ): SessionMode {
    if (classifiedMode === "agent") return "agent";
    if (classifiedMode === "other" && summary?.backend === "tmux" && st.modeHint) return st.modeHint;
    if (st.modeHint === "agent") {
      const promptFresh = st.lastPromptAt > 0 && now - st.lastPromptAt <= READINESS_PROMPT_WINDOW_MS;
      if (promptFresh) return "agent";
    }
    return classifiedMode;
  }

  private ensureReadiness(ptyId: string): PtyReadyState {
    let st = this.readinessByPty.get(ptyId);
    if (st) return st;
    st = {
      state: "unknown",
      indicator: "busy",
      reason: "startup",
      updatedAt: Date.now(),
      lastOutputAt: 0,
      lastPromptAt: 0,
      recentAgentOutputTail: "",
      timer: null,
      busyDelayTimer: null,
      modeHint: null,
      agentFamilyHint: null,
      lastCwd: null,
      logState: null,
      logReason: null,
      logUpdatedAt: 0,
    };
    this.readinessByPty.set(ptyId, st);
    return st;
  }

  private clearReadinessTimer(st: PtyReadyState): void {
    if (!st.timer) return;
    clearTimeout(st.timer);
    st.timer = null;
  }

  private clearBusyDelayTimer(st: PtyReadyState): void {
    if (!st.busyDelayTimer) return;
    clearTimeout(st.busyDelayTimer);
    st.busyDelayTimer = null;
  }

  private scheduleBusyDelay(ptyId: string, reason: string): void {
    const st = this.ensureReadiness(ptyId);
    if (st.busyDelayTimer) return;
    st.busyDelayTimer = setTimeout(() => {
      st.busyDelayTimer = null;
      const promptFresh = st.lastPromptAt > 0 && Date.now() - st.lastPromptAt <= READINESS_BUSY_DELAY_MS + 40;
      if (promptFresh) return;
      this.setPtyReadiness(ptyId, "busy", reason);
    }, READINESS_BUSY_DELAY_MS);
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
    const indicator =
      state === "ready" ? "ready" : state === "busy" ? "busy" : (indicatorOverride ?? st.indicator);
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
    });
  }

  private outputLooksLikePrompt(chunk: string): boolean {
    const cleaned = stripAnsi(chunk).replaceAll("\r", "\n");
    const tail = cleaned.slice(-800);
    if (/proceed \(y\)\?\s*$/i.test(tail)) return true;
    if (/(password|username|login):\s*$/i.test(tail)) return true;

    const recentLines = tail
      .split("\n")
      .map((line) => line.replaceAll("\u00a0", " ").trimEnd())
      .filter((line) => line.trim().length > 0)
      .slice(-8);

    for (const line of recentLines) {
      if (/^[^\n]{0,180}[$#%]\s?$/.test(line)) return true;
      if (/^[^\n]{0,180}(?:>|>>|>>>|❯|›)\s?$/u.test(line)) return true;
      if (/^[^\n]{0,180}\s(?:>|>>|>>>|❯|›)\s?$/u.test(line)) return true;
      if (/^\s*(?:❯|›)\s+\S.{0,240}$/u.test(line)) return true;
    }

    return false;
  }

  private outputHasVisibleText(chunk: string): boolean {
    const visible = stripAnsi(chunk)
      .replaceAll("\u00a0", " ")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim();
    return visible.length > 0;
  }

  private agentUnknownDecision(
    st: PtyReadyState,
    now: number,
    unknownReason: string,
  ): { state: PtyReadinessState; reason: string; promoteInMs: number | null } {
    const basisTs = st.lastPromptAt > 0 ? st.lastPromptAt : st.lastOutputAt;
    if (basisTs <= 0) {
      return { state: "unknown", reason: unknownReason, promoteInMs: READINESS_AGENT_UNKNOWN_TO_READY_MS };
    }
    const quietMs = now - basisTs;
    if (quietMs >= READINESS_AGENT_UNKNOWN_TO_READY_MS) {
      return { state: "ready", reason: "agent:settled", promoteInMs: null };
    }
    return { state: "unknown", reason: unknownReason, promoteInMs: READINESS_AGENT_UNKNOWN_TO_READY_MS - quietMs };
  }

  private setAgentUnknownOrReady(
    ptyId: string,
    st: PtyReadyState,
    now: number,
    unknownReason: string,
    emitEvent = true,
  ): void {
    const decision = this.agentUnknownDecision(st, now, unknownReason);
    this.setPtyReadiness(ptyId, decision.state, decision.reason, emitEvent);
    if (emitEvent && decision.promoteInMs != null) {
      this.scheduleReadinessRecompute(ptyId, Math.max(READINESS_QUIET_MS, decision.promoteInMs + 10));
    }
  }

  private async tmuxSessionShowsPrompt(
    ptyId: string,
    tmuxSession: string,
    mode: SessionMode,
    agentFamily: AgentFamily | null,
  ): Promise<boolean> {
    const snapshot = await tmuxCapturePaneVisible(tmuxSession);
    if (!snapshot) return false;
    const promptVisible =
      mode === "agent"
        ? outputShowsAgentPromptMarker(snapshot, agentFamily) ||
          (agentFamily === "other" && this.outputLooksLikePrompt(snapshot))
        : this.outputLooksLikePrompt(snapshot);
    if (!promptVisible) return false;
    this.ensureReadiness(ptyId).lastPromptAt = Date.now();
    return true;
  }

  private scheduleReadinessRecompute(ptyId: string, delayMs = READINESS_QUIET_MS): void {
    const st = this.ensureReadiness(ptyId);
    this.clearReadinessTimer(st);
    st.timer = setTimeout(() => {
      st.timer = null;
      void this.recomputeReadiness(ptyId);
    }, Math.max(10, delayMs));
  }

  private async recomputeReadiness(ptyId: string): Promise<void> {
    const st = this.ensureReadiness(ptyId);
    const summary = this.deps.ptys.getSummary(ptyId);
    if (!summary || summary.status !== "running") {
      this.setPtyReadiness(ptyId, "busy", "exited");
      return;
    }

    // If log state is fresh, apply it directly and skip terminal-based recompute.
    if (st.logState !== null && Date.now() - st.logUpdatedAt < LOG_STATE_TTL_MS) {
      this.setPtyReadiness(ptyId, st.logState, st.logReason!);
      return;
    }

    const now = Date.now();
    let activeProcess: string | null = summary.activeProcess ?? null;
    if (summary.backend === "tmux" && summary.tmuxSession) {
      const [proc, liveCwd] = await Promise.all([
        tmuxPaneActiveProcess(summary.tmuxSession),
        tmuxPaneCurrentPath(summary.tmuxSession),
      ]);
      activeProcess = proc;
      if (liveCwd) this.deps.ptys.updateCwd(ptyId, liveCwd);
    } else {
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

    const mode = this.classifySessionMode(summary, activeProcess);
    const effectiveMode = this.effectiveSessionMode(st, summary, mode, now);
    const agentFamily =
      effectiveMode === "agent" ? (this.detectAgentFamily(summary, activeProcess) ?? st.agentFamilyHint) : null;
    st.modeHint = effectiveMode;
    st.agentFamilyHint = agentFamily;

    const sinceOutput = now - st.lastOutputAt;
    if (st.lastOutputAt > 0 && sinceOutput < READINESS_QUIET_MS) {
      const promptJustSeen = st.lastPromptAt > 0 && now - st.lastPromptAt <= READINESS_BUSY_DELAY_MS + 80;
      if (promptJustSeen) {
        this.scheduleReadinessRecompute(ptyId, READINESS_QUIET_MS - sinceOutput + 5);
        return;
      }
      if (
        effectiveMode !== "agent" &&
        summary.backend === "tmux" &&
        summary.tmuxSession &&
        activeProcess &&
        !this.isShellProcess(activeProcess)
      ) {
        if (await this.tmuxSessionShowsPrompt(ptyId, summary.tmuxSession, effectiveMode, agentFamily)) {
          this.setPtyReadiness(ptyId, "ready", "prompt-visible");
          this.scheduleReadinessRecompute(ptyId, READINESS_QUIET_MS - sinceOutput + 5);
          return;
        }
      }
      this.setPtyReadiness(ptyId, "busy", effectiveMode === "agent" ? "agent:output" : "output");
      this.scheduleReadinessRecompute(ptyId, READINESS_QUIET_MS - sinceOutput + 5);
      return;
    }

    const promptFresh = st.lastPromptAt > 0 && now - st.lastPromptAt <= READINESS_PROMPT_WINDOW_MS;
    if (promptFresh) {
      if (effectiveMode === "agent") this.setAgentUnknownOrReady(ptyId, st, now, "agent:prompt-stable");
      else this.setPtyReadiness(ptyId, "ready", "prompt");
      return;
    }

    if (summary.backend === "tmux" && summary.tmuxSession && activeProcess && !this.isShellProcess(activeProcess)) {
      if (await this.tmuxSessionShowsPrompt(ptyId, summary.tmuxSession, effectiveMode, agentFamily)) {
        if (effectiveMode === "agent") this.setAgentUnknownOrReady(ptyId, st, now, "agent:prompt-visible");
        else this.setPtyReadiness(ptyId, "ready", "prompt-visible");
        return;
      }
      this.setPtyReadiness(ptyId, "busy", `process:${this.normalizeProcessName(activeProcess)}`);
      return;
    }

    if (summary.backend === "tmux" && summary.tmuxSession && !activeProcess) {
      if (await this.tmuxSessionShowsPrompt(ptyId, summary.tmuxSession, effectiveMode, agentFamily)) {
        if (effectiveMode === "agent") this.setAgentUnknownOrReady(ptyId, st, now, "agent:prompt-visible");
        else this.setPtyReadiness(ptyId, "ready", "prompt-visible");
        return;
      }
      this.setPtyReadiness(ptyId, "unknown", "tmux:process-unresolved");
      return;
    }

    if (summary.backend === "tmux" && (!activeProcess || this.isShellProcess(activeProcess))) {
      if (effectiveMode === "agent") this.setAgentUnknownOrReady(ptyId, st, now, "agent:idle-shell");
      else this.setPtyReadiness(ptyId, "ready", "idle-shell");
      return;
    }

    if (effectiveMode === "agent") {
      this.setAgentUnknownOrReady(ptyId, st, now, "agent:idle");
      return;
    }
    this.setPtyReadiness(ptyId, "unknown", "unknown");
  }

  private readinessSignalSource(reason: string): string {
    if (reason.startsWith("log:")) return "jsonl-log";
    if (reason.startsWith("agent:")) return "agent-signal";
    if (reason.startsWith("prompt")) return "prompt-detector";
    if (reason.startsWith("process:")) return "foreground-process";
    if (reason.startsWith("tmux:")) return "tmux-pane-inspection";
    if (reason.startsWith("input")) return "input-event";
    if (reason.startsWith("output")) return "output-event";
    if (reason === "idle-shell") return "shell-idle";
    if (reason === "exited") return "process-exit";
    return "status-engine";
  }
}
