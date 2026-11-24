"use client";

import { useEffect, useRef } from "react";
import { bridgeResolveMcpRequest } from "@/lib/tauri-api";
import { isTauri, loadTauriCore } from "@/lib/tauri/runtime";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";
import { resolveMcpSpawnRunner, type McpSpawnRunnerSpec } from "../services/mcp-canvas-spawn";
import { decideSpawnTarget } from "../services/mcp-canvas-spawn-target";
import { mcpSpawnBudget, spawnBudgetExhaustedMessage } from "../services/canvas-spawn-budget";
import {
  mcpSpawnDepth,
  nodeIdFromPaneId,
  spawnDepthExceededMessage,
} from "../services/canvas-spawn-depth";
import type { Node } from "@xyflow/react";
import { decideTaskFrame, type TaskFrameDecision } from "../services/canvas-task-frame";
import type { FrameSeed } from "../services/canvas-frames";
import type { SpawnTaskStamp } from "../services/commands/canvas-command";

/**
 * Phase 2b — Agent Orchestrator spawn on the canvas. The MCP `lotus_spawn_cell` tool round-trips via
 * Rust's `mcp://spawn-cell` event; on the canvas route this bridge handles it by spawning an auto-named
 * live agent NODE (the codespace bridge spawns a terminal cell instead — only one route is mounted at a
 * time). `provider` is enum-constrained by the sidecar; `runnerId` is a free override. Resolves
 * the pending Rust request with the new node id as `paneId`.
 *
 * Mount once inside CanvasPage. No-op outside Tauri.
 */
type SpawnPayload = {
  requestId: string;
  provider: string;
  workspaceId?: string | null;
  /** First task auto-submitted once the agent is live (spawn-with-brief). */
  initialPrompt?: string | null;
  /** Runner/CLI id override; defaults to `provider`. */
  runnerId?: string | null;
  cwd?: string | null;
  role?: string | null;
  /** Pane id of the agent that asked for this spawn; absent when a human asked. */
  fromPaneId?: string | null;
  /**
   * Whether the new agent asks before acting. Absent keeps the runner registry's own
   * setting, which is what every caller before the phone relied on.
   *
   * **Honoured here rather than passed along and forgotten.** `resolveRunnerLaunch`
   * lets a node's own mode beat the registry's `skip_permissions`, so a `safe` request
   * has somewhere to land — and without this the phone would promise a cell that asks
   * while the registry (every entry of which is `skip_permissions: true` on the machine
   * this was measured on) launched it ungated. A promise nothing afterwards would
   * contradict is the worst kind.
   */
  permissionMode?: string | null;
  /** `spawn-tuning`: the model alias and effort the phone chose. Absent = the CLI's defaults. */
  model?: string | null;
  effort?: string | null;
  /** Claude account the phone chose (issues/07); absent = this desktop's chosen one. Checked by Rust. */
  profileId?: string | null;
  /** Target Frame: its id, or its exact title. Absent = the usual placement. */
  frame?: string | null;
  /** The Lotus task this spawn is for (LOT2-130): cells for one task share a Frame named after it. */
  task?: { id?: string | null; title?: string | null } | null;
};

/**
 * What this bridge remembers of earlier spawns per task, because the `nodes` a handler sees is a
 * React render behind when spawns arrive in parallel. Only trusted for a few seconds (the service
 * judges `fresh`); after that the board itself is the truth, so a Frame the user deleted stays gone.
 */
const TASK_MEMORY_FRESH_MS = 3_000;
type TaskMemory = Map<string, { looseNodeId?: string; frameId?: string; at: number }>;

/** Drop memories older than the trust window: they can only mislead after it. */
function pruneTaskMemory(memory: TaskMemory, now: number): void {
  for (const [key, entry] of memory) if (now - entry.at >= TASK_MEMORY_FRESH_MS) memory.delete(key);
}

const SPAWN_EVENT = "mcp://spawn-cell";
const MAX_SEEN_REQUEST_IDS = 200;
const seenRequestIds: string[] = [];
const seenRequestIdSet = new Set<string>();

function markSeen(requestId: string): boolean {
  if (seenRequestIdSet.has(requestId)) return false;
  seenRequestIdSet.add(requestId);
  seenRequestIds.push(requestId);
  while (seenRequestIds.length > MAX_SEEN_REQUEST_IDS) {
    const old = seenRequestIds.shift();
    if (old) seenRequestIdSet.delete(old);
  }
  return true;
}

export interface McpCanvasSpawnDeps {
  /** Spawn a canvas agent node for the resolved runner; returns the new node id (or null on failure). */
  spawnAgent: (
    spec: McpSpawnRunnerSpec,
    opts: { initialTask?: string; permissionMode?: string; model?: string; effort?: string; account?: string; frameId?: string; spawnTask?: SpawnTaskStamp },
  ) => string | null;
  /** Current board nodes; with `createFrame` enables grouping an agent's cells per task. */
  nodes?: readonly Node[];
  /** Wrap nodes in a new Frame (optionally titled and keyed to a task); returns the Frame id. */
  createFrame?: (ids: string[], seed?: FrameSeed) => string | null;
  /** Resolve a Frame reference (id or exact title) against the mounted board. */
  resolveFrame: (ref: string) => { id: string } | { error: string };
  /** Project whose board is mounted right now — what `workspaceId` is judged against. */
  activeProjectId: string | null;
  /** Every project this window can switch to. A request naming anything else is refused. */
  knownProjectIds: readonly string[];
  /** Bring another project's board on screen. Fire-and-forget; readiness is observed, not awaited. */
  switchToProject: (projectId: string) => void;
  /** False while a board is still loading — spawning into a half-mounted board misplaces the node. */
  boardReady: boolean;
}

/**
 * How long to wait for a requested board to come on screen.
 *
 * Rust abandons the whole spawn at 10s, and the node creation plus its IPC reply still
 * have to fit afterwards. Six leaves that margin: a switch that has not landed by then
 * would resolve as an opaque gateway timeout instead of a sentence naming the project.
 */
const SWITCH_BUDGET_MS = 6_000;
const SWITCH_POLL_MS = 50;

/**
 * Resolves once the asked-for board is mounted *and* finished loading.
 *
 * Reads through `deps()` rather than a captured value on purpose — the switch lands as a
 * React re-render, so only the live ref sees it.
 */
export async function waitForBoard(
  projectId: string,
  deps: () => McpCanvasSpawnDeps,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  const deadline = now() + SWITCH_BUDGET_MS;
  for (;;) {
    const d = deps();
    if (d.activeProjectId === projectId && d.boardReady) return true;
    if (now() >= deadline) return false;
    await sleep(SWITCH_POLL_MS);
  }
}

export function useMcpCanvasSpawnBridge(deps: McpCanvasSpawnDeps): void {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  // Per mounted canvas, not per module: one canvas's task memory must never decide another's Frame.
  const taskMemoryRef = useRef<TaskMemory>(new Map());

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;

    (async () => {
      await loadTauriCore();
      const { listen } = await import("@tauri-apps/api/event");
      const next = await listen<SpawnPayload>(SPAWN_EVENT, async (event) => {
        const payload = event.payload;
        if (!payload?.requestId || !payload.provider) return;
        if (!markSeen(payload.requestId)) return;

        // Decided first, because it is pure and a refusal must cost nothing: no spawn
        // budget burned, and above all no board switched for a request that cannot be
        // honoured anyway. Substituting the mounted board here is the bug this replaces.
        const target = decideSpawnTarget(
          payload.workspaceId,
          depsRef.current.activeProjectId,
          depsRef.current.knownProjectIds,
        );
        if (target.kind === "refuse") {
          await bridgeResolveMcpRequest({
            requestId: payload.requestId,
            ok: false,
            error: target.reason,
          });
          return;
        }

        // An unknown Frame refuses before any budget is spent. When the request first has to switch
        // boards the Frame can only be judged after the switch, so that case checks again below.
        const frameRef = payload.frame?.trim() || undefined;
        const refuseFrame = async (error: string) =>
          bridgeResolveMcpRequest({ requestId: payload.requestId, ok: false, error });
        if (frameRef && target.kind === "spawn-here") {
          const found = depsRef.current.resolveFrame(frameRef);
          if ("error" in found) return void (await refuseFrame(found.error));
        }

        // Bound unattended delegation on two axes, both before any runner lookup or node creation:
        // depth stops one chain from recursing, the session budget stops many chains from adding up.
        const parentNodeId = nodeIdFromPaneId(payload.fromPaneId);
        if (mcpSpawnDepth.wouldExceed(parentNodeId)) {
          await bridgeResolveMcpRequest({
            requestId: payload.requestId,
            ok: false,
            error: spawnDepthExceededMessage(mcpSpawnDepth.depthOf(parentNodeId!)),
          });
          return;
        }
        if (!mcpSpawnBudget.tryConsume()) {
          await bridgeResolveMcpRequest({
            requestId: payload.requestId,
            ok: false,
            error: spawnBudgetExhaustedMessage(mcpSpawnBudget),
          });
          return;
        }
        try {
          // The board the operator named, brought on screen before anything is created.
          // Deliberately without a prompt on the desktop: the phone is the operator too,
          // and a dialog nobody is sitting in front of is a spawn that never happens.
          if (target.kind === "switch-first") {
            depsRef.current.switchToProject(target.projectId);
            if (!(await waitForBoard(target.projectId, () => depsRef.current))) {
              await bridgeResolveMcpRequest({
                requestId: payload.requestId,
                ok: false,
                error: `Could not open project \`${target.projectId}\` in time, so nothing was started — the agent would have landed in the wrong project.`,
              });
              return;
            }
          }
          let frameId: string | undefined;
          if (frameRef) {
            const found = depsRef.current.resolveFrame(frameRef);
            if ("error" in found) return void (await refuseFrame(found.error));
            frameId = found.id;
          }
          // Cells an agent spawns for one task group into one Frame. An explicit `frame` wins.
          const taskId = payload.task?.id?.trim();
          let taskDecision: TaskFrameDecision = { kind: "none" };
          if (!frameId && taskId && depsRef.current.createFrame) {
            const taskMemory = taskMemoryRef.current;
            pruneTaskMemory(taskMemory, Date.now());
            const memory = taskMemory.get(`${depsRef.current.activeProjectId ?? ""}\u0000${taskId}`);
            taskDecision = decideTaskFrame({
              nodes: depsRef.current.nodes ?? [],
              task: { id: taskId, title: payload.task?.title },
              pending: memory
                ? { looseNodeId: memory.looseNodeId, frameId: memory.frameId, fresh: Date.now() - memory.at < TASK_MEMORY_FRESH_MS }
                : undefined,
            });
            if (taskDecision.kind === "reuse") frameId = taskDecision.frameId;
          }
          const spec = resolveMcpSpawnRunner(payload.provider, payload.runnerId);
          const nodeId = depsRef.current.spawnAgent(spec, {
            initialTask: payload.initialPrompt?.trim() || undefined,
            // Passed through, not collapsed. `yolo` becomes `full` because that is the
            // canvas' own word for the gate being off; every other stop is a word
            // `resolveRunnerCommand` knows, and folding `acceptEdits` into `full` here was
            // what made the phone's scale unable to say anything but *asks* or *does not*.
            // Absent leaves the registry's setting alone.
            ...(payload.permissionMode
              ? { permissionMode: payload.permissionMode === "yolo" ? "full" : payload.permissionMode }
              : {}),
            // Aliases the CLI resolves; the node's launch spec turns them into flags.
            ...(payload.model?.trim() ? { model: payload.model.trim() } : {}),
            ...(payload.effort?.trim() ? { effort: payload.effort.trim() } : {}),
            ...(payload.profileId?.trim() ? { account: payload.profileId.trim() } : {}),
            ...(frameId ? { frameId } : {}),
            ...(taskId ? { spawnTask: { key: taskId, ...(payload.task?.title?.trim() ? { title: payload.task.title.trim() } : {}) } } : {}),
          });
          if (nodeId && taskId) {
            const taskMemory = taskMemoryRef.current;
            const memoryKey = `${depsRef.current.activeProjectId ?? ""}\u0000${taskId}`;
            if (taskDecision.kind === "loose") {
              taskMemory.set(memoryKey, { looseNodeId: nodeId, at: Date.now() });
            } else if (taskDecision.kind === "create" && depsRef.current.createFrame) {
              const createdFrameId = depsRef.current.createFrame([taskDecision.pullNodeId, nodeId], {
                title: taskDecision.title,
                taskKey: taskDecision.taskKey,
                // Task cells land at a cascade spot, usually under the active Frame: give their Frame free space.
                relocate: true,
              });
              // Nothing was wrapped (the first cell is gone): stay loose and remember this one.
              if (createdFrameId) taskMemory.set(memoryKey, { frameId: createdFrameId, at: Date.now() });
              else taskMemory.set(memoryKey, { looseNodeId: nodeId, at: Date.now() });
            } else if (taskDecision.kind === "reuse") {
              taskMemory.set(memoryKey, { frameId: taskDecision.frameId, at: Date.now() });
            }
          }
          // Record the lineage so the new agent's own spawns are counted a generation deeper.
          if (nodeId) mcpSpawnDepth.record(nodeId, parentNodeId);
          await bridgeResolveMcpRequest({
            requestId: payload.requestId,
            ok: Boolean(nodeId),
            data: nodeId
              ? { paneId: nodeId, provider: payload.provider, runner: spec.runner, label: spec.label }
              : undefined,
            error: nodeId ? undefined : "canvas spawn returned no node id",
          });
        } catch (err) {
          await bridgeResolveMcpRequest({
            requestId: payload.requestId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
      if (disposed) {
        safeTauriUnlisten(next);
        return;
      }
      unlisten = next;
    })();

    return () => {
      disposed = true;
      safeTauriUnlisten(unlisten);
    };
  }, []);
}
