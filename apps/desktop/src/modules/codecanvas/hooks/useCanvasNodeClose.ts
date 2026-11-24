"use client";
import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Edge, Node } from "@xyflow/react";
import { destroyPersistentPtyConfirmed, getPersistentPtySnapshot } from "@/lib/pty-session-pool";
import { forgetClosedAgent } from "../services/closed-agent-cleanup";
import { closeTerminalSession } from "@/modules/codespace/services/terminal-session-registry";
import { resetTerminalActivity } from "@/modules/codespace/services/terminal-activity-registry";
import { canvasRuntimePaneId } from "../services/canvas-runtime-scope";
import { stopHeadlessAgent } from "../services/headless-agent-sessions";
import { detachNodeSessions } from "../services/session-mutations";
import { canvasSessionStore } from "../services/session-store";
import { detachOrphanedMembers, frameIdOf } from "../services/canvas-frames";
import { canvasFrameRetileStore } from "../services/canvas-frame-retile-store";

interface CloseDeps {
  nodesRef: { current: Node[] };
  edgesRef: { current: Edge[] };
  projectIdRef: { current: string | null };
  autosaveRef: { current: (nodes: Node[], edges: Edge[]) => void };
  setNodes: Dispatch<SetStateAction<Node[]>>;
  setEdges: Dispatch<SetStateAction<Edge[]>>;
}

export function useCanvasNodeClose({ nodesRef, edgesRef, projectIdRef, autosaveRef, setNodes, setEdges }: CloseDeps) {
  const [closeError, setCloseError] = useState<string | null>(null);
  const pending = useRef(new Map<string, Promise<boolean>>());

  const removeNode = useCallback((nodeId: string, delayMs = 0): Promise<boolean> => {
    const projectId = projectIdRef.current;
    const paneId = canvasRuntimePaneId(projectId, nodeId);
    const existing = pending.current.get(paneId);
    if (existing) return existing;
    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (!node) return Promise.resolve(true);
    setCloseError(null);
    const animation = delayMs > 0 ? new Promise<void>((resolve) => window.setTimeout(resolve, delayMs)) : null;
    const close = async (): Promise<boolean> => {
      try {
        if (node.type === "agent") {
          const sessionId = getPersistentPtySnapshot(paneId)?.sessionId;
          await Promise.all([destroyPersistentPtyConfirmed(paneId), stopHeadlessAgent(paneId)]);
          forgetClosedAgent(paneId, nodeId, sessionId);
        }
        const runtimePaneId = typeof node.data.runtimePaneId === "string" ? node.data.runtimePaneId : nodeId;
        closeTerminalSession(runtimePaneId);
        resetTerminalActivity(runtimePaneId);
        if (projectId) await detachNodeSessions(canvasSessionStore, projectId, nodeId);
        if (animation) await animation;
        // A stop receipt from an outgoing board must never mutate the incoming board.
        if (projectIdRef.current !== projectId) return true;
        const nextEdges = edgesRef.current.filter((e) => e.source !== nodeId && e.target !== nodeId);
        const nextNodes = detachOrphanedMembers(nodesRef.current.filter((n) => n.id !== nodeId));
        edgesRef.current = nextEdges;
        nodesRef.current = nextNodes;
        setEdges(nextEdges);
        setNodes(nextNodes);
        autosaveRef.current(nextNodes, nextEdges);
        const frameId = frameIdOf(node);
        if (frameId) canvasFrameRetileStore.request(frameId, { kind: "close", isNote: node.type === "note" });
        return true;
      } catch (error) {
        console.warn("[canvas] node close failed:", error);
        if (projectIdRef.current === projectId) {
          setCloseError("Agent belum berhasil ditutup. Node tetap disimpan; coba Close lagi.");
          setNodes((nds) => nds.map((n) => n.id === nodeId
            ? { ...n, className: (n.className ?? "").split(" ").filter((c) => c !== "canvas-node-leaving").join(" ") }
            : n));
        }
        return false;
      }
    };
    const task = close().finally(() => { pending.current.delete(paneId); });
    pending.current.set(paneId, task);
    return task;
  }, [nodesRef, edgesRef, projectIdRef, autosaveRef, setNodes, setEdges]);

  const removeAllNodes = useCallback(async (delayMs = 0): Promise<void> => {
    await Promise.all(nodesRef.current.map((node) => removeNode(node.id, delayMs)));
  }, [nodesRef, removeNode]);

  const onBeforeDelete = useCallback(async ({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) => {
    // ReactFlow otherwise deletes touching edges before a failed node stop can be retried.
    const ids = new Set(nodes.map((node) => node.id));
    await Promise.all(nodes.map((node) => removeNode(node.id)));
    return { nodes: [], edges: edges.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target)) };
  }, [removeNode]);

  const waitForNodeCloses = useCallback(async () => {
    while (pending.current.size > 0) await Promise.all(pending.current.values());
    return { nodes: nodesRef.current, edges: edgesRef.current };
  }, [nodesRef, edgesRef]);

  return { removeNode, removeAllNodes, closeError, waitForNodeCloses, onBeforeDelete };
}
