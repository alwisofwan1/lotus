"use client";

import { useEffect, useRef } from "react";
import { bridgeResolveMcpRequest } from "@/lib/tauri-api";
import { isTauri, loadTauriCore } from "@/lib/tauri/runtime";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";
import type { Edge, Node } from "@xyflow/react";
import { buildDrawApplication, type DrawApplication, type DrawRequest } from "../services/agent-draw/canvas-draw-runtime";
import { planDiagramDraw } from "../services/agent-draw/diagram-draw-plan";
import type { SceneReadback } from "../services/agent-draw/scene-readback";
import { getCanvasBehaviorSettings } from "./useCanvasBehaviorSettings";

/**
 * Agent canvas-draw bridge — lets agents draw shapes and generate diagrams via the MCP tools
 * `lotus_canvas_draw` / `lotus_canvas_draw_diagram`. Rust (`/v1/canvas-draw`) emits
 * `mcp://canvas-draw` with a requestId; we honour it ONLY when the user has enabled "Let agents
 * draw & generate diagrams" (Settings → Canvas, off by default) — a gate distinct from
 * canvas-control because drawing mutates board content, not just the camera.
 *
 * The hook is a thin transport shell: the request is validated + laid out by the pure
 * {@link buildDrawApplication} runtime, then handed to the injected {@link CanvasDrawBridgeDeps.commit}
 * for a single atomic board mutation. Mount once inside CanvasPage. No-op outside Tauri.
 */
export interface CanvasDrawPayload extends DrawRequest {
  requestId: string;
  /** Placement hint the host resolves to a flow-space anchor. */
  anchor?: "viewport-center" | { near?: string };
}

export interface CanvasDrawBridgeDeps {
  /** Flow-space origin op-local coordinates are measured from (viewport centre or near a node). */
  resolveAnchor: (payload: CanvasDrawPayload) => { x: number; y: number };
  /** Ids of shapes currently on the board — the resolvable targets for connect/update/delete. */
  existingShapeIds: () => Set<string>;
  /** Width (px) of one line at the diagram font, for text-based diagram sizing. */
  measure: (text: string) => number;
  /** Apply the planned application to the board atomically and record its draft ledger batch. */
  commit: (application: DrawApplication) => void;
  /** Summarize the current canvas (shapes + connectors, tiered) so the agent can edit what exists. */
  readScene: () => SceneReadback;
  /** Live board — lets diagram-mode draws reconcile against existing diagrams (edit-in-place). */
  board: () => { nodes: Node[]; edges: Edge[] };
}

const EVENT = "mcp://canvas-draw";
const READ_EVENT = "mcp://canvas-read-shapes";
const GATE_DENIAL = "Agent drawing is disabled by the user (Settings → Canvas → Let agents draw & generate diagrams).";

export function useMcpCanvasDrawBridge(deps: CanvasDrawBridgeDeps): void {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  // Rust may re-emit on client retry; apply each draw requestId once.
  const handledRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!isTauri()) return;
    const unlisteners: Array<() => void> = [];
    let disposed = false;

    const track = (un: () => void) => {
      if (disposed) safeTauriUnlisten(un);
      else unlisteners.push(un);
    };

    (async () => {
      await loadTauriCore();
      const { listen } = await import("@tauri-apps/api/event");

      // Draw: validate + lay out + commit (mutation).
      track(await listen<CanvasDrawPayload>(EVENT, async (event) => {
        const payload = event.payload;
        if (!payload?.requestId) return;
        const resolve = (ok: boolean, data?: unknown, error?: string) =>
          bridgeResolveMcpRequest({ requestId: payload.requestId, ok, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) });
        try {
          if (!getCanvasBehaviorSettings().allowAgentCanvasDraw) {
            await resolve(false, undefined, GATE_DENIAL);
            return;
          }
          if (handledRef.current.has(payload.requestId)) return;
          handledRef.current.add(payload.requestId);

          const { resolveAnchor, existingShapeIds, measure, commit, board } = depsRef.current;
          const isDiagram = (payload.mode ?? (payload.graph ? "diagram" : "ops")) === "diagram";
          // Diagram mode goes through the SAME orchestrator as the NL path, so an agent re-sending a
          // graph with existing ids edits in place (replaces) instead of drawing a duplicate.
          const result = isDiagram
            ? planDiagramDraw({
                graph: payload.graph ?? { nodes: [], edges: [] },
                direction: payload.direction,
                title: typeof payload.frame === "object" ? payload.frame.title : undefined,
                frame: payload.frame !== false,
                ...board(),
                baseAnchor: resolveAnchor(payload),
                makeId: () => crypto.randomUUID(),
                measure,
              })
            : buildDrawApplication(payload, {
                anchor: resolveAnchor(payload),
                existingShapeIds: existingShapeIds(),
                makeId: () => crypto.randomUUID(),
                measure,
              });
          if ("error" in result) {
            handledRef.current.delete(payload.requestId); // a rejected request may be retried after fixing
            await resolve(false, undefined, result.error);
            return;
          }
          commit(result);
          await resolve(true, result.receipt);
        } catch (err) {
          handledRef.current.delete(payload.requestId);
          await resolve(false, undefined, err instanceof Error ? err.message : String(err));
        }
      }));

      // Read-back: pure snapshot of the canvas so the agent can edit what's there (no mutation, so
      // it's naturally idempotent — no dedup needed). Same gate as draw.
      track(await listen<{ requestId?: string }>(READ_EVENT, async (event) => {
        const requestId = event.payload?.requestId;
        if (!requestId) return;
        const resolve = (ok: boolean, data?: unknown, error?: string) =>
          bridgeResolveMcpRequest({ requestId, ok, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) });
        try {
          if (!getCanvasBehaviorSettings().allowAgentCanvasDraw) {
            await resolve(false, undefined, GATE_DENIAL);
            return;
          }
          await resolve(true, depsRef.current.readScene());
        } catch (err) {
          await resolve(false, undefined, err instanceof Error ? err.message : String(err));
        }
      }));
    })();

    return () => {
      disposed = true;
      for (const un of unlisteners) safeTauriUnlisten(un);
    };
  }, []);
}
