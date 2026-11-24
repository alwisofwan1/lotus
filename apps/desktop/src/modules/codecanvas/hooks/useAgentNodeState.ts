"use client";
import { useCallback, useRef, useState } from "react";
import {
  createTauriAgentRunner,
  type AgentRunner,
} from "@/lib/tauri/canvas-agent";
import { registerHeadlessAgentStop } from "../services/headless-agent-sessions";
import { parseAgentStreamLine } from "../services/agent-stream-parser";
import {
  INITIAL_AGENT_STATE,
  agentStatusReducer,
  type AgentRuntimeState,
} from "../services/agent-status";
import {
  EMPTY_RUN_VIEW,
  agentRunViewReducer,
  runViewActions,
  type AgentRunView,
} from "../services/agent-run-view";
import { buildAgentRunPrompt, type AgentContextSource } from "../services/agent-run-prompt";
import { buildRunRecord, type AgentRunRecord, type AgentRunUsage, type RunOutcome, type RunKind } from "../services/agent-run-record";
import { splitImageRefs } from "../services/canvas-run-attachments";
import type { CanvasImageRef } from "../services/canvas-intake";
import type { AgentNodeStatus } from "../types/canvas";

export interface UseAgentNodeStateOptions {
  prompt: string;
  model: string;
  cwd: string;
  runner?: AgentRunner;
  /** Skill names applied to every run, injected into the run prompt. */
  appliedSkills?: string[];
  /** Resolves the upstream context sources at run time; the active run id drives staleness of bus artifacts. */
  getContext?: (activeGraphRunId?: string | null) => AgentContextSource[];
  /** Resolves the image attachments (own + connected nodes) to feed this run. */
  getAttachments?: () => CanvasImageRef[] | Promise<CanvasImageRef[]>;
  /** Resolves the names of all agents on the canvas at run time (owner vocabulary for plan.md). */
  getRoster?: () => string[];
  /** Per-agent governance applied to every run. */
  effort?: string;
  skipPermissions?: boolean;
  /** Canvas node id + sink for completed run records (trace history). */
  agentId?: string;
  runtimePaneId?: string;
  onRunComplete?: (record: AgentRunRecord) => void;
}

export interface UseAgentNodeStateResult {
  status: AgentNodeStatus;
  /** Structured run output: ordered messages + tool activity. */
  view: AgentRunView;
  /** The Claude session id once the stream reports one — null before the first turn. */
  sessionId: string | null;
  /** True once a session exists and the agent is not mid-run — a reply can resume it. */
  canReply: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  sendReply: (text: string) => Promise<void>;
}

/** Owns the lifecycle of one headless agent: spawn, stream → status + view, stop. */
export function useAgentNodeState({
  prompt,
  model,
  cwd,
  runner,
  appliedSkills,
  getContext,
  getAttachments,
  getRoster,
  effort,
  skipPermissions,
  agentId,
  runtimePaneId,
  onRunComplete,
}: UseAgentNodeStateOptions): UseAgentNodeStateResult {
  const runnerRef = useRef<AgentRunner>(runner ?? createTauriAgentRunner());
  const [runtime, setRuntime] = useState<AgentRuntimeState>(INITIAL_AGENT_STATE);
  const [view, setView] = useState<AgentRunView>(EMPTY_RUN_VIEW);
  const viewRef = useRef<AgentRunView>(EMPTY_RUN_VIEW);
  const runIdRef = useRef<string | null>(null);
  const pendingStartRef = useRef<Promise<void> | null>(null);
  const pendingStopRef = useRef<Promise<void> | null>(null);
  const unregisterStopRef = useRef<(() => void) | null>(null);
  const activeRunTokenRef = useRef(0);
  // Trace capture for the current run/turn.
  const activeRunRef = useRef(false);
  const startedAtRef = useRef(0);
  const kindRef = useRef<RunKind>("run");
  const sessionIdRef = useRef<string | null>(null);
  const graphRunIdRef = useRef<string | null>(null);
  const usageRef = useRef<AgentRunUsage | null>(null);

  const finalizeRun = useCallback((outcome: RunOutcome, summary?: string) => {
    if (!activeRunRef.current || !agentId || !onRunComplete) return;
    activeRunRef.current = false;
    onRunComplete(buildRunRecord({
      agentId, kind: kindRef.current, outcome,
      startedAt: startedAtRef.current, endedAt: Date.now(),
      sessionId: sessionIdRef.current, graphRunId: graphRunIdRef.current, usage: usageRef.current,
      actions: runViewActions(viewRef.current), summary,
    }));
  }, [agentId, onRunComplete]);

  const beginRun = useCallback((kind: RunKind, sessionId: string | null) => {
    const runToken = activeRunTokenRef.current + 1;
    activeRunTokenRef.current = runToken;
    activeRunRef.current = true;
    startedAtRef.current = Date.now();
    kindRef.current = kind;
    sessionIdRef.current = sessionId;
    usageRef.current = null;
    return runToken;
  }, []);

  const pushView = useCallback((reducer: (v: AgentRunView) => AgentRunView) => {
    viewRef.current = reducer(viewRef.current);
    setView(viewRef.current);
  }, []);

  const onLine = useCallback((runToken: number, line: string) => {
    if (runToken !== activeRunTokenRef.current) return;
    const event = parseAgentStreamLine(line);
    if (!event) return;
    setRuntime((prev) => agentStatusReducer(prev, event));
    pushView((v) => agentRunViewReducer(v, event));
    if (event.kind === "session") {
      sessionIdRef.current = event.sessionId;
    } else if (event.kind === "result") {
      if (event.usage) usageRef.current = event.usage;
      finalizeRun(event.ok ? "completed" : "error", event.text);
    } else if (event.kind === "exit") {
      unregisterStopRef.current?.();
      runIdRef.current = null;
      finalizeRun(event.code === 0 ? "completed" : "error");
    }
  }, [finalizeRun, pushView]);

  const resetView = useCallback(() => { viewRef.current = EMPTY_RUN_VIEW; setView(EMPTY_RUN_VIEW); }, []);

  const stop = useCallback((): Promise<void> => {
    if (pendingStopRef.current) return pendingStopRef.current;
    activeRunTokenRef.current += 1;
    const task = async () => {
      // A pending launch owns a future run id; do not report stopped before it can be cancelled.
      await pendingStartRef.current?.catch(() => undefined);
      const runId = runIdRef.current;
      if (runId) await runnerRef.current.stop(runId);
      runIdRef.current = null;
      unregisterStopRef.current?.();
      finalizeRun("stopped");
      setRuntime((prev) => (prev.status === "running" || prev.status === "connecting"
        ? { ...prev, status: "idle" }
        : prev));
    };
    const pending = task().finally(() => { pendingStopRef.current = null; });
    pendingStopRef.current = pending;
    return pending;
  }, [finalizeRun]);

  const start = useCallback(async (ctx?: { graphRunId?: string | null }) => {
    setRuntime({ ...INITIAL_AGENT_STATE, status: "connecting" });
    resetView();
    graphRunIdRef.current = ctx?.graphRunId ?? null;
    const runToken = beginRun("run", null);
    const fullPrompt = buildAgentRunPrompt({
      rolePrompt: prompt,
      skills: appliedSkills,
      context: getContext?.(ctx?.graphRunId ?? null) ?? [],
      roster: getRoster?.() ?? [],
      skipPermissions,
    });
    if (runtimePaneId) unregisterStopRef.current = registerHeadlessAgentStop(runtimePaneId, stop);
    const launch = async () => {
      const attachmentRefs = await Promise.resolve(getAttachments?.() ?? []);
      if (runToken !== activeRunTokenRef.current) return;
      const { attachments: imageAttachments, paths: imagePaths } = splitImageRefs(attachmentRefs);
      runIdRef.current = await runnerRef.current.start({
        prompt: fullPrompt,
        model,
        cwd,
        onLine: (line) => onLine(runToken, line),
        effort,
        skipPermissions,
        imageAttachments,
        imagePaths,
      });
    };
    const pending = launch();
    pendingStartRef.current = pending;
    try { await pending; } finally { if (pendingStartRef.current === pending) pendingStartRef.current = null; }
  }, [prompt, model, cwd, onLine, appliedSkills, getContext, getAttachments, getRoster, effort, skipPermissions, beginRun, resetView, runtimePaneId, stop]);

  // Resume the existing session with a follow-up — continues the same run, keeping prior output.
  const sendReply = useCallback(async (text: string) => {
    const sessionId = runtime.sessionId;
    if (!sessionId || !text.trim()) return;
    setRuntime((prev) => ({ ...prev, status: "connecting" }));
    graphRunIdRef.current = null; // replies are manual, never graph-driven
    const runToken = beginRun("reply", sessionId);
    if (runtimePaneId) unregisterStopRef.current = registerHeadlessAgentStop(runtimePaneId, stop);
    const pending = runnerRef.current.start({
      prompt: text,
      model,
      cwd,
      onLine: (line) => onLine(runToken, line),
      resumeSessionId: sessionId,
      effort,
      skipPermissions,
    }).then((runId) => { runIdRef.current = runId; });
    pendingStartRef.current = pending;
    try { await pending; } finally { if (pendingStartRef.current === pending) pendingStartRef.current = null; }
  }, [runtime.sessionId, model, cwd, onLine, effort, skipPermissions, beginRun, runtimePaneId, stop]);

  const canReply = !!runtime.sessionId && runtime.status !== "connecting" && runtime.status !== "running";

  return { status: runtime.status, view, sessionId: runtime.sessionId, canReply, start, stop, sendReply };
}
