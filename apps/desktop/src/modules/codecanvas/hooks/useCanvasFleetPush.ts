"use client";
import { useEffect, useMemo, useRef } from "react";
import type { Node } from "@xyflow/react";
import { isTauri, loadTauriCore } from "@/lib/tauri/runtime";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";
import { agentStatusRegistry } from "../services/agent-status-registry";
import { agentHeadlineStore } from "../services/agent-headline-store";
import type { AgentStatusSnapshot } from "../services/agent-status-registry";
import { agentReplyRegistry } from "../services/agent-reply-registry";
import {
  projectCanvasAgentStatusSnapshots,
  type CanvasFleetAgentNodeRef,
  type CanvasFleetContext,
  type CanvasProjectIdentity,
} from "../services/canvas-fleet";
import { getCanvasFleetPushScheduler } from "../services/canvas-fleet-push-scheduler";
import { logCanvasFleetDiagnostics } from "../services/canvas-fleet-diagnostics";
import type { CanvasAgentNodeData } from "../types/canvas";

/** Rust asks the UI to re-push the fleet NOW when it can't resolve a dispatch target (F4). */
const FLEET_REFRESH_EVENT = "mcp://request-fleet-refresh";

/** Terminal/non-responsive statuses that bypass debounce and push to the fleet immediately. */
const CRITICAL_STATUSES: ReadonlySet<AgentStatusSnapshot["status"]> = new Set([
  "error",
  "completed",
  "stalled",
]);

function listHasCriticalStatus(list: AgentStatusSnapshot[]): boolean {
  for (const s of list) {
    if (CRITICAL_STATUSES.has(s.status)) return true;
  }
  return false;
}

/**
 * Mirrors the canvas agent nodes into the Lotus fleet (its own `canvas:` namespace),
 * so they surface in lotus_list_fleet / Bridge without clobbering CodeSpace.
 * No-op outside Tauri (the push wrapper guards on isTauri).
 *
 * Delegates timing to a shared {@link getCanvasFleetPushScheduler} so a route toggle,
 * HMR, or StrictMode double-invoke no longer transiently blanks the fleet — only a
 * genuine teardown clears it (RC3/F3). Also answers Rust's pull-on-miss refresh request
 * (F4) with an immediate re-push. See canvas-fleet-push-scheduler.ts.
 *
 * Critical status changes (error, completed, stalled) bypass the 200ms debounce and push
 * immediately via {@link CanvasFleetPushScheduler.handleCriticalSnapshot}, so dispatches
 * don't hit a stale "running" snapshot that would 404 or queue into a dead agent.
 */
function agentRefsFromNodes(nodes: readonly Node[]): CanvasFleetAgentNodeRef[] {
  return nodes
    .filter((node) => node.type === "agent")
    .map((node) => {
      const data = node.data as Partial<CanvasAgentNodeData> | undefined;
      return {
        id: node.id,
        name: typeof data?.name === "string" && data.name.trim() ? data.name : node.id,
        runner: data?.runner,
        runnerCommand: typeof data?.runnerCommand === "string" ? data.runnerCommand : undefined,
        projectId: typeof data?.projectId === "string" ? data.projectId : null,
      };
    });
}

export interface CanvasFleetPushInput {
  projectId: string | null;
  cwd: string;
  nodes?: readonly Node[];
  projectName?: string | null;
  /**
   * Every project this window can name, so an agent belonging to a project other than the
   * one on screen is still placed in **its own** project rather than the board's. See
   * {@link CanvasFleetContext.projects}.
   */
  projects?: Readonly<Record<string, CanvasProjectIdentity>>;
}

export function useCanvasFleetPush({
  projectId,
  cwd,
  nodes = [],
  projectName = null,
  projects,
}: CanvasFleetPushInput): void {
  const agents = useMemo(() => agentRefsFromNodes(nodes), [nodes]);
  const agentsSignature = JSON.stringify(agents);
  const agentsRef = useRef<CanvasFleetAgentNodeRef[]>(agents);
  agentsRef.current = agents;
  // Serialized for the dep list for the same reason `agents` is: the catalog is rebuilt on
  // every render, and comparing it by reference would re-push on each one.
  const projectsSignature = JSON.stringify(projects ?? null);

  useEffect(() => {
    const scheduler = getCanvasFleetPushScheduler();
    const ctx: CanvasFleetContext = { projectId, cwd, projectName, ...(projects ? { projects } : {}) };
    const projectSnapshot = (list: AgentStatusSnapshot[]) => projectCanvasAgentStatusSnapshots(agentsRef.current, list, ctx);
    // Phase 0 observability: on each push, log (dev-only) the projection breakdown so a "visible
    // agent missing from the fleet" failure shows exactly which layer dropped it, in the console —
    // instead of only surfacing as an agent saying a teammate "doesn't exist". Cheap: reads live
    // registries by the visible node ids (agentReplyRegistry has get()).
    const logDiagnostics = (list: AgentStatusSnapshot[], projected: AgentStatusSnapshot[]) => {
      const nodes = agentsRef.current;
      logCanvasFleetDiagnostics({
        agentNodes: nodes.map((n) => ({ id: n.id, name: n.name })),
        registry: list,
        replyHandleIds: nodes.filter((n) => agentReplyRegistry.get(n.id)).map((n) => n.id),
        replyReadyIds: nodes.filter((n) => agentReplyRegistry.get(n.id)?.canReply()).map((n) => n.id),
        pushedFleetNodeIds: projected.map((s) => s.id),
        snapshotAgeMs: null,
      });
    };
    scheduler.handleMount();

    // Debounced for normal state changes; critical statuses (error/completed/stalled) use
    // handleCriticalSnapshot for immediate push — keeps fleet freshness sub-100ms on terminal events.
    const unsubscribe = agentStatusRegistry.subscribe((list) => {
      const projected = projectSnapshot(list);
      logDiagnostics(list, projected);
      if (listHasCriticalStatus(projected)) {
        scheduler.handleCriticalSnapshot(projected, ctx);
      } else {
        scheduler.handleSnapshot(projected, ctx);
      }
    });
    const initial = agentStatusRegistry.list();
    const initialProjected = projectSnapshot(initial);
    logDiagnostics(initial, initialProjected);
    scheduler.handleSnapshot(initialProjected, ctx);

    // Headlines change without the status registry moving at all — a running agent handed a new
    // instruction keeps its status and gains a new ask. Without this subscription that ask would sit
    // in the frontend store and never reach `lotus_list_fleet`, so a dispatching agent would read the
    // PREVIOUS one. Debounced like any other change; the store only notifies when a displayed line
    // actually changed, so an idle board is silent.
    const unsubscribeHeadlines = agentHeadlineStore.subscribe(() => {
      scheduler.handleSnapshot(projectSnapshot(agentStatusRegistry.list()), ctx);
    });

    // Pull-on-miss: re-push immediately when Rust can't resolve a target against a stale snapshot.
    let unlisten: (() => void) | null = null;
    let disposed = false;
    if (isTauri()) {
      void (async () => {
        await loadTauriCore();
        const { listen } = await import("@tauri-apps/api/event");
        const next = await listen(FLEET_REFRESH_EVENT, () => {
          scheduler.forcePush(projectSnapshot(agentStatusRegistry.list()), ctx);
        });
        if (disposed) safeTauriUnlisten(next);
        else unlisten = next;
      })();
    }

    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeHeadlines();
      safeTauriUnlisten(unlisten);
      scheduler.handleUnmount(ctx);
    };
    // `projectName` joins the deps for the same reason `cwd` is here: renaming a
    // project has to reach the fleet, or every remote client keeps printing the old
    // name until something else happens to trigger a push.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, cwd, projectName, agentsSignature, projectsSignature]);
}
