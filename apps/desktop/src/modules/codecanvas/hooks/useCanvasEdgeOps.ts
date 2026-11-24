import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import { type Edge, type IsValidConnection, type Node, type OnConnect, type OnReconnect } from "@xyflow/react";
import { buildCanvasWireEdge, type CanvasWireKind } from "../services/canvas-wire-style";
import { inferEdgeKind, cycleEdgeKind } from "../services/canvas-edge-semantics";
import { isValidCanvasConnection } from "../services/canvas-edge-validation";

type CanvasWireHandleEnd = "source" | "target";

interface EdgeOpsDeps {
  setEdges: Dispatch<SetStateAction<Edge[]>>;
  nodesRef: { current: Node[] };
  edgesRef: { current: Edge[] };
  autosaveRef: { current: (nodes: Node[], edges: Edge[]) => void };
}

function wireKindOf(edge: Edge | undefined): CanvasWireKind {
  return (edge?.data as { wireKind?: CanvasWireKind } | undefined)?.wireKind ?? "default";
}

function customLabelOf(edge: Edge): string | undefined {
  return (edge.data as { customLabel?: string } | undefined)?.customLabel;
}

function typeOf(nodes: readonly Node[], id: string | null | undefined): string | undefined {
  return nodes.find((node) => node.id === id)?.type;
}

function kindFor(nodes: readonly Node[], source: string | null | undefined, target: string | null | undefined): CanvasWireKind {
  return inferEdgeKind(typeOf(nodes, source), typeOf(nodes, target));
}

/** Edge mutation callbacks for the canvas: connect, reconnect, retype, re-port, cycle, delete. */
export function useCanvasEdgeOps({ setEdges, nodesRef, edgesRef, autosaveRef }: EdgeOpsDeps) {
  const commit = useCallback(
    (updater: (eds: Edge[]) => Edge[]) =>
      setEdges((eds) => {
        const next = updater(eds);
        autosaveRef.current(nodesRef.current, next);
        return next;
      }),
    [setEdges, nodesRef, autosaveRef],
  );

  const isValidConnection = useCallback<IsValidConnection>(
    (connection) => isValidCanvasConnection(
      connection,
      nodesRef.current,
      edgesRef.current,
      "id" in connection ? connection.id : undefined,
    ),
    [edgesRef, nodesRef],
  );

  const onConnect = useCallback<OnConnect>(
    (params) =>
      commit((eds) => {
        if (!isValidCanvasConnection(params, nodesRef.current, eds)) return eds;
        const kind = kindFor(nodesRef.current, params.source, params.target);
        return [
          ...eds,
          buildCanvasWireEdge({
            source: params.source,
            target: params.target,
            kind,
            animated: kind !== "default",
            sourceHandle: params.sourceHandle,
            targetHandle: params.targetHandle,
          }),
        ];
      }),
    [commit, nodesRef],
  );

  const setEdgeKind = useCallback(
    (edgeId: string, kind: CanvasWireKind) =>
      commit((eds) =>
        eds.map((e) => {
          if (e.id !== edgeId) return e;
          const cl = customLabelOf(e);
          return buildCanvasWireEdge({
            id: e.id,
            source: e.source,
            target: e.target,
            kind,
            animated: kind !== "default",
            sourceHandle: e.sourceHandle,
            targetHandle: e.targetHandle,
            ...(cl !== undefined ? { label: cl } : {}),
          });
        }),
      ),
    [commit],
  );

  const cycleEdgeSemantic = useCallback(
    (edgeId: string) =>
      commit((eds) => {
        const target = eds.find((e) => e.id === edgeId);
        if (!target) return eds;
        const nextKind = cycleEdgeKind(
          wireKindOf(target),
          typeOf(nodesRef.current, target.source),
          typeOf(nodesRef.current, target.target),
        );
        return eds.map((e) => {
          if (e.id !== edgeId) return e;
          const cl = customLabelOf(e);
          return buildCanvasWireEdge({
            id: e.id,
            source: e.source,
            target: e.target,
            kind: nextKind,
            animated: nextKind !== "default",
            sourceHandle: e.sourceHandle,
            targetHandle: e.targetHandle,
            ...(cl !== undefined ? { label: cl } : {}),
          });
        });
      }),
    [commit, nodesRef],
  );

  const setEdgeHandle = useCallback(
    (edgeId: string, end: CanvasWireHandleEnd, handleId: string) =>
      commit((eds) =>
        eds.map((e) => {
          if (e.id !== edgeId) return e;
          const kind = wireKindOf(e);
          const cl = customLabelOf(e);
          return buildCanvasWireEdge({
            id: e.id,
            source: e.source,
            target: e.target,
            kind,
            animated: kind !== "default",
            sourceHandle: end === "source" ? handleId : e.sourceHandle,
            targetHandle: end === "target" ? handleId : e.targetHandle,
            ...(cl !== undefined ? { label: cl } : {}),
          });
        }),
      ),
    [commit],
  );

  const removeEdge = useCallback(
    (edgeId: string) => commit((eds) => eds.filter((e) => e.id !== edgeId)),
    [commit],
  );

  const updateEdgeLabel = useCallback(
    (edgeId: string, newLabel: string) =>
      commit((eds) =>
        eds.map((e) => {
          if (e.id !== edgeId) return e;
          const trimmed = newLabel.trim();
          return {
            ...e,
            label: trimmed || undefined,
            data: { ...(e.data ?? {}), customLabel: trimmed },
          };
        }),
      ),
    [commit],
  );

  const onReconnect = useCallback<OnReconnect>(
    (oldEdge, newConnection) => {
      if (!newConnection.source || !newConnection.target) return;
      commit((eds) => {
        if (!isValidCanvasConnection(newConnection, nodesRef.current, eds, oldEdge.id)) return eds;
        const kind = kindFor(nodesRef.current, newConnection.source, newConnection.target);
        return eds.map((e) => {
          if (e.id !== oldEdge.id) return e;
          const cl = customLabelOf(e);
          return buildCanvasWireEdge({
            id: e.id,
            source: newConnection.source,
            target: newConnection.target,
            kind,
            animated: kind !== "default",
            sourceHandle: newConnection.sourceHandle,
            targetHandle: newConnection.targetHandle,
            ...(cl !== undefined ? { label: cl } : {}),
          });
        });
      });
    },
    [commit, nodesRef],
  );

  return { onConnect, onReconnect, isValidConnection, setEdgeKind, cycleEdgeSemantic, setEdgeHandle, removeEdge, updateEdgeLabel };
}
