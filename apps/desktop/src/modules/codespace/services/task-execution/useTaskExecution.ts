"use client";

import { useCallback, useRef, useState } from "react";
import type {
  BridgeTask,
  UpdateTaskPatch,
} from "@/modules/codespace/services/bridge/task-store";
import type { PtyOutputMetrics } from "@/lib/tauri-api";
import { buildTaskPrompt, type TaskPromptContext } from "./buildTaskPrompt";
import { buildBridgeEnvelope } from "./buildBridgeEnvelope";
import { waitForPtyReady } from "./waitForPtyReady";
import { quietSettler, writePromptToPty, type Settle } from "./writePrompt";
import { submitAsKeystrokes, type SubmitKeystrokeOptions } from "@/lib/agent-runtime/tui-handover";

const DEFAULT_AGENT = "claude";
const DIRECT_AGENT_COMMANDS = new Map<string, string>([
  ["claude", "claude"],
  ["codex", "codex"],
  ["gemini", "gemini"],
  ["opencode", "opencode"],
  ["cursor", "cursor"],
  ["copilot", "gh copilot"],
  ["ccs-hss", "ccs hss"],
  ["ccs hss", "ccs hss"],
]);

/** Which task a pane is opened for: a host that groups cells by task (the canvas) reads it. */
export interface PaneTask {
  id: string;
  title?: string;
  /** `LOT-2` — what the person calls it. */
  key?: string;
}

export type TaskExecutionPrimitives = {
  /** Add a pane to a workspace, returns the new pane id (async when the host first switches board). */
  addPane: (
    workspaceId: string,
    agentCommand: string,
    cwdOverride?: string,
    task?: PaneTask,
    /** Lotus Claude account the pane runs on (issues/07). */
    claudeAccount?: string,
  ) => string | Promise<string>;
  /**
   * Resolves true once the pane's program owns the terminal (bracketed paste or alt screen), false
   * at the timeout. Only for a pane that runs the agent as the PTY's own process: a shell arms the
   * same marker before the agent has even been typed. Absent: wait for the output to go quiet.
   */
  awaitHandover?: (paneId: string, opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<boolean>;
  /** Wait for the PTY session id to materialise on a freshly added pane. */
  awaitSessionId: (paneId: string, opts: { timeoutMs?: number; signal?: AbortSignal }) => Promise<string | null>;
  /** Send a string into the PTY (terminating CR included by caller). */
  writeToSession: (sessionId: string, data: string) => Promise<void>;
  /** Kill a PTY session by id (used for cancel / re-run). */
  killSession: (sessionId: string) => Promise<void>;
  /** Activity snapshot for ready detection. */
  getMetrics: (sessionId: string) => Promise<PtyOutputMetrics | null>;
  /** Persist task changes (status / cellId / lastError). */
  updateTask: (taskId: string, patch: UpdateTaskPatch & { cellId?: string | null }) => Promise<unknown>;
  /** Side-effect after the pane is created (e.g. switch view + focus the cell). */
  onPostSpawn?: (paneId: string) => void;
  /** Resolve the active Bridge orchestrator pane in a workspace, if any.
   * `sessionId` may be null when the Bridge lives in the right panel
   * (synthetic id `${workspaceId}:right-bridge`); in that case the caller
   * must dispatch via `dispatchToBridge` rather than `writeToSession`. */
  findBridgePane?: (workspaceId: string) => { paneId: string; sessionId: string | null } | null;
  /** Send a payload to a Bridge pane via the cell-bus orchestrator:dispatch
   * channel. This routes through the same path OrchestratorCell uses, so
   * intent metadata, encoding, and notifications all behave consistently
   * regardless of whether the Bridge is a grid cell or right-panel cell. */
  dispatchToBridge?: (args: { paneId: string; workspaceId: string; payload: string }) => void;
};

export type DispatchMode = "direct" | "bridge";

/** Describes a drop target resolved by the caller (CodeSpacePage owns the
 *  workspace state). The hook stays decoupled from cell-tree traversal. */
export type CellDispatchTarget = {
  cellId: string;
  /** Discriminator for routing logic. */
  cellType: "terminal" | "orchestrator" | "browser" | "workbench" | "other";
  /** Live PTY id, if the cell has one. */
  runtimeSessionId: string | null;
  /** Explicit `agentCommand` on TerminalCell, or sniffed `detectedAgent`. */
  agentCommand: string | null;
};

export type TaskExecutionResult = {
  ok: boolean;
  paneId?: string;
  sessionId?: string;
  error?: string;
};

export type UseTaskExecutionOptions = {
  workspaceId: string | null;
  primitives: TaskExecutionPrimitives;
  /** Optional context the prompt builder will prefix. */
  promptContext?: TaskPromptContext;
  /** PTY ready timeout. Default 8000ms. */
  readyTimeoutMs?: number;
  /** awaitSessionId timeout. Default 6000ms. */
  sessionTimeoutMs?: number;
  /**
   * What to wait for between the prompt and the return that submits it.
   *
   * A parameter rather than a buried wait because it is real time, and a test on fake timers would
   * hang on it forever. Defaults to "until the pane stops printing", which is the question that
   * actually matters: a fresh agent is still drawing itself when the prompt lands.
   */
  promptSettle?: Settle;
  /** How long a directly launched agent may take to own its terminal. Default 45s (a cold `ccs`). */
  handoverTimeoutMs?: number;
  /** Timings for typing into a handed-over TUI; tests pass a no-op sleep. */
  handoverKeystrokes?: SubmitKeystrokeOptions;
};

/**
 * Pass as `workspaceId` when the host has no one workspace: each task is executed in its own
 * (`task.workspaceId`). Only `execute` honours it; `executeIntoCell` targets a cell, which has one.
 */
export const EACH_TASK_WORKSPACE = "\u0000each-task";

export function useTaskExecution({
  workspaceId,
  primitives,
  promptContext,
  readyTimeoutMs = 8_000,
  sessionTimeoutMs = 6_000,
  promptSettle,
  handoverTimeoutMs = 45_000,
  handoverKeystrokes,
}: UseTaskExecutionOptions) {
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(new Set());
  const [lastError, setLastError] = useState<string | null>(null);
  // Per-task abort controllers + active sessionId — keyed by taskId so cancel()
  // can find them without React state churn.
  const abortRef = useRef<Map<string, { ctrl: AbortController; sessionId: string | null }>>(new Map());

  const addInFlight = useCallback((id: string) => {
    setInFlight((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const removeInFlight = useCallback((id: string) => {
    setInFlight((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const execute = useCallback(
    async (
      task: BridgeTask,
      opts?: {
        mode?: DispatchMode;
        /** From the preset. Overrides the guess made from `task.assignees`. */
        agent?: string;
        /** From the preset. Standing orders for this kind of worker, beyond the task itself. */
        instructions?: string;
        /** `INT-2` — per task, not per hook, which is why it rides with the call. */
        taskKey?: string;
        /** The folder to work in when it is not the workspace root (a GitHub issue's checkout). */
        cwd?: string;
        /** From the preset: the Lotus Claude account the worker runs on. */
        claudeAccount?: string;
      },
    ): Promise<TaskExecutionResult> => {
      const mode: DispatchMode = opts?.mode ?? "direct";
      // A host that delegates tasks from several workspaces (a canvas's task nodes) lets each task
      // bring its own.
      const ws = workspaceId === EACH_TASK_WORKSPACE ? task.workspaceId || null : workspaceId;
      if (!ws) {
        const err = "No workspace selected";
        setLastError(err);
        return { ok: false, error: err };
      }
      // Idempotency guard — second call for same task while first is alive is a no-op.
      if (abortRef.current.has(task.id)) {
        return { ok: false, error: "Execution already in flight for this task" };
      }

      const ctrl = new AbortController();
      const slot: { ctrl: AbortController; sessionId: string | null } = { ctrl, sessionId: null };
      abortRef.current.set(task.id, slot);
      addInFlight(task.id);
      setLastError(null);

      try {
        // Bridge mode: route the task through the workspace's existing
        // orchestrator cell instead of spawning a fresh CLI. The Bridge
        // LLM decides which subagent (if any) to spawn via MCP tools.
        // We dispatch via the cell-bus orchestrator:dispatch channel — the
        // same path OrchestratorCell uses internally — so encoding,
        // intent metadata, and notifications stay consistent and the
        // mechanism works for Bridge cells in EITHER the grid or the
        // right panel.
        if (mode === "bridge") {
          if (!primitives.findBridgePane) {
            throw new Error("Bridge dispatch unavailable: primitives missing findBridgePane");
          }
          const bridge = primitives.findBridgePane(ws);
          if (!bridge) {
            throw new Error("No active Bridge cell in this workspace. Open the Bridge panel first.");
          }
          slot.sessionId = bridge.sessionId;
          if (ctrl.signal.aborted) throw new DOMException("aborted", "AbortError");

          const envelope = buildBridgeEnvelope(task, promptContext);
          if (primitives.dispatchToBridge) {
            primitives.dispatchToBridge({
              paneId: bridge.paneId,
              workspaceId: ws,
              payload: envelope,
            });
          } else if (bridge.sessionId) {
            // Fallback: direct PTY write when bus dispatcher isn't wired.
            await primitives.writeToSession(bridge.sessionId, envelope + "\r");
          } else {
            throw new Error("Bridge dispatch unavailable: no dispatchToBridge primitive and no sessionId");
          }

          await primitives.updateTask(task.id, {
            status: "in-progress",
            cellId: bridge.paneId,
          });
          return { ok: true, paneId: bridge.paneId, sessionId: bridge.sessionId ?? bridge.paneId };
        }

        // Direct mode (default) — spawn fresh CLI pane and dispatch into it.
        // A preset names the worker outright; `pickAgent` only guesses from whoever was assigned,
        // and a guess is the wrong basis for something that spawns a process and spends money.
        const agent = opts?.agent?.trim() || pickAgent(task);
        const cwdOverride = opts?.cwd ?? (task as { cwd?: string }).cwd; // future-friendly: prefer task.cwd if model gains it
        const paneId = await primitives.addPane(ws, agent, cwdOverride, {
          id: task.id,
          title: task.title,
          ...(opts?.taskKey ? { key: opts.taskKey } : {}),
        }, opts?.claudeAccount);

        primitives.onPostSpawn?.(paneId);

        const sessionId = await primitives.awaitSessionId(paneId, {
          timeoutMs: sessionTimeoutMs,
          signal: ctrl.signal,
        });
        if (!sessionId) {
          throw new Error("PTY session never came up for the new pane");
        }
        slot.sessionId = sessionId;

        if (ctrl.signal.aborted) throw new DOMException("aborted", "AbortError");

        const base = buildTaskPrompt(
          task,
          opts?.taskKey ? { ...promptContext, taskKey: opts.taskKey } : promptContext,
        );
        const extra = opts?.instructions?.trim();
        const prompt = extra ? `${base}\n${extra}\n` : base;

        /*
          An agent that IS the PTY's process (no shell) is still booting when its session id
          appears; the tty is in cooked mode until it takes over, so a prompt and its return written
          then reach it as ONE read, a paste, and sit in the input box unsent (seen 2026-10-17: a
          canvas delegation whose session never wrote a transcript). Its own handover is the signal.
        */
        const handed = primitives.awaitHandover
          ? await primitives.awaitHandover(paneId, { timeoutMs: handoverTimeoutMs, signal: ctrl.signal })
          : false;
        if (ctrl.signal.aborted) throw new DOMException("aborted", "AbortError");
        if (handed) {
          await submitAsKeystrokes(
            (data) => primitives.writeToSession(sessionId, data),
            prompt.replace(/[\r\n\s]+$/, ""),
            handoverKeystrokes,
          );
        } else {
          const ready = await waitForPtyReady(sessionId, primitives.getMetrics, {
            timeoutMs: readyTimeoutMs,
            signal: ctrl.signal,
          });
          if (ready.reason === "aborted") {
            throw new DOMException("aborted", "AbortError");
          }
          if (ready.reason === "gone") {
            throw new Error("PTY session vanished before it became ready");
          }
          // "timeout" with shell still alive is acceptable — many agents print
          // their banner only after first prompt. We send anyway; the worst
          // case is the agent buffers the input.

          // Text first, return second. One write carrying both is read by a TUI as a paste, and the
          // prompt then sits in the agent's input box while the pane looks like it is working.
          await writePromptToPty(
            sessionId,
            prompt,
            primitives.writeToSession,
            promptSettle ?? quietSettler(primitives.getMetrics),
          );
        }

        await primitives.updateTask(task.id, {
          status: "in-progress",
          cellId: paneId,
        });

        return { ok: true, paneId, sessionId };
      } catch (err) {
        const aborted = ctrl.signal.aborted || isAbortError(err);
        // If cancelled mid-flight after sessionId was acquired, ensure the
        // session is reaped here too — cancel() may have run before the
        // sessionId existed, in which case its kill was a no-op.
        if (aborted && slot.sessionId) {
          void primitives.killSession(slot.sessionId).catch(() => undefined);
        }
        const message = aborted ? "Cancelled" : errorMessage(err);
        if (!aborted) setLastError(message);
        return { ok: false, error: message };
      } finally {
        abortRef.current.delete(task.id);
        removeInFlight(task.id);
      }
    },
    [
      workspaceId,
      primitives,
      promptContext,
      readyTimeoutMs,
      sessionTimeoutMs,
      promptSettle,
      handoverTimeoutMs,
      handoverKeystrokes,
      addInFlight,
      removeInFlight,
    ],
  );

  /**
   * Dispatch a task into a SPECIFIC, already-existing cell — the path used
   * when the user drags a task card onto a pane. Routing is decided by the
   * cell type:
   *
   *   - orchestrator     → dispatchToBridge (same envelope as bridge mode,
   *                        but explicitly pinned to this cell's paneId).
   *   - terminal + agent → writeToSession on the cell's PTY.
   *   - terminal + shell → reject (no agent listening).
   *   - browser/workbench/other → reject.
   *
   * The caller is responsible for resolving the cell to a `CellDispatchTarget`;
   * we don't traverse workspace state from inside the hook.
   */
  const executeIntoCell = useCallback(
    async (task: BridgeTask, target: CellDispatchTarget): Promise<TaskExecutionResult> => {
      if (!workspaceId) {
        const err = "No workspace selected";
        setLastError(err);
        return { ok: false, error: err };
      }
      if (abortRef.current.has(task.id)) {
        return { ok: false, error: "Execution already in flight for this task" };
      }

      // Reject incompatible cell types early — the UI should already have
      // rendered a "drop rejected" hover state, but we defend at the
      // primitive boundary too.
      if (target.cellType === "browser" || target.cellType === "workbench" || target.cellType === "other") {
        const err = `Can't dispatch a task to a ${target.cellType} cell — try an agent terminal or the Bridge cell.`;
        setLastError(err);
        return { ok: false, error: err };
      }

      const ctrl = new AbortController();
      const slot: { ctrl: AbortController; sessionId: string | null } = {
        ctrl,
        sessionId: target.runtimeSessionId,
      };
      abortRef.current.set(task.id, slot);
      addInFlight(task.id);
      setLastError(null);

      try {
        if (target.cellType === "orchestrator") {
          // Pin the bridge envelope to THIS orchestrator pane so workspaces
          // with multiple Bridge cells route to the one the user dropped on,
          // not whatever findBridgePane considers active.
          const envelope = buildBridgeEnvelope(task, promptContext);
          if (primitives.dispatchToBridge) {
            primitives.dispatchToBridge({
              paneId: target.cellId,
              workspaceId,
              payload: envelope,
            });
          } else if (target.runtimeSessionId) {
            await primitives.writeToSession(target.runtimeSessionId, envelope + "\r");
          } else {
            throw new Error("Bridge cell has no live session and no dispatchToBridge primitive");
          }
          await primitives.updateTask(task.id, {
            status: "in-progress",
            cellId: target.cellId,
          });
          return {
            ok: true,
            paneId: target.cellId,
            sessionId: target.runtimeSessionId ?? target.cellId,
          };
        }

        // terminal cell — must have a live session AND an agent listening.
        if (!target.runtimeSessionId) {
          throw new Error("Cell has no live PTY session yet — wait a moment and try again.");
        }
        if (!target.agentCommand) {
          throw new Error("Drop target is a plain shell, not an agent. Run an agent in this pane first.");
        }

        const prompt = buildTaskPrompt(task, promptContext);
        await primitives.writeToSession(target.runtimeSessionId, prompt + "\r");

        await primitives.updateTask(task.id, {
          status: "in-progress",
          cellId: target.cellId,
        });

        return { ok: true, paneId: target.cellId, sessionId: target.runtimeSessionId };
      } catch (err) {
        const message = errorMessage(err);
        setLastError(message);
        return { ok: false, error: message };
      } finally {
        abortRef.current.delete(task.id);
        removeInFlight(task.id);
      }
    },
    [workspaceId, primitives, promptContext, addInFlight, removeInFlight],
  );

  const cancel = useCallback(
    (taskId: string) => {
      const slot = abortRef.current.get(taskId);
      if (!slot) return;
      slot.ctrl.abort();
      const sid = slot.sessionId;
      // Fire-and-forget the kill + status update — both are independently safe.
      if (sid) void primitives.killSession(sid).catch(() => undefined);
      void primitives.updateTask(taskId, { status: "cancelled", cellId: null }).catch(() => undefined);
    },
    [primitives],
  );

  return { execute, executeIntoCell, cancel, inFlight, lastError };
}

function pickAgent(task: BridgeTask): string {
  for (const assignee of task.assignees) {
    const command = commandFromAssignee(assignee);
    if (command) return command;
  }
  return DEFAULT_AGENT;
}

function commandFromAssignee(raw: string): string | null {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/\s+/g, " ");
  if (!normalized) return null;

  const exact = DIRECT_AGENT_COMMANDS.get(normalized);
  if (exact) return exact;

  for (const [agent, command] of DIRECT_AGENT_COMMANDS) {
    if (normalized.startsWith(`${agent}-`) || normalized.startsWith(`${agent}_`)) {
      return command;
    }
  }

  return null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}
