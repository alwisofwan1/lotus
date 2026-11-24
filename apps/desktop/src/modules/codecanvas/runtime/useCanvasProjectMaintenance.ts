"use client";
import { useEffect, useRef } from "react";
import type { Node } from "@xyflow/react";
import { getActiveProjectLocation } from "../services/canvas-active-project";
import { listWorktreesFor } from "../services/remote-git";
import type { CanvasTaskNodeData } from "../types/canvas";
import { agentStatusRegistry } from "../services/agent-status-registry";
import { rollUpTaskStatus } from "../services/task-status-rollup";
import { validateWorktreeAssignments } from "../services/worktree-validation";

interface UseCanvasProjectMaintenanceOptions {
  nodes: Node[];
  rootDir: string;
  activeProjectId: string | null;
  patchNodeData: (nodeId: string, patch: Record<string, unknown>) => void;
}

/**
 * Project-scoped maintenance effects: live task status rollup and stale worktree
 * assignment cleanup. Uses refs for project-switch work so effects do not need
 * render-phase dependency suppression in CanvasPage.
 */
export function useCanvasProjectMaintenance({
  nodes,
  rootDir,
  activeProjectId,
  patchNodeData,
}: UseCanvasProjectMaintenanceOptions) {
  const latestRef = useRef({ nodes, rootDir, patchNodeData });

  useEffect(() => {
    latestRef.current = { nodes, rootDir, patchNodeData };
  }, [nodes, rootDir, patchNodeData]);

  useEffect(() => {
    return agentStatusRegistry.subscribe((roster) => {
      const { nodes: latestNodes, patchNodeData: patch } = latestRef.current;
      for (const node of latestNodes) {
        if (node.type !== "task") continue;
        const d = node.data as CanvasTaskNodeData;
        const next = rollUpTaskStatus(d.dispatchedAgentIds ?? [], roster, d.status);
        if (next) patch(node.id, { status: next });
      }
    });
  }, []);

  useEffect(() => {
    const { nodes: latestNodes, rootDir: latestRootDir, patchNodeData: patch } = latestRef.current;
    if (!latestRootDir) return;
    const assignedNodes = latestNodes
      .filter((n) => n.type === "terminal" || n.type === "agent")
      .map((n) => {
        const d = n.data as Record<string, unknown>;
        return {
          id: n.id,
          cwd: (typeof d.cwd === "string" ? d.cwd : null) ?? latestRootDir,
          assignedWorktree: typeof d.assignedWorktree === "string" ? d.assignedWorktree : null,
          assignedWorktreePath: typeof d.assignedWorktreePath === "string" ? d.assignedWorktreePath : null,
        };
      });
    // A node's worktree lives on the project's machine, so the sweep has to ask that machine —
    // otherwise a remote assignment is checked against this laptop's repos and cleared as stale.
    const machine = getActiveProjectLocation();
    void validateWorktreeAssignments(assignedNodes, (cwd) => listWorktreesFor(machine, cwd))
      .then((stale) => {
        stale.forEach((clearance, nodeId) => patch(nodeId, clearance as Record<string, unknown>));
      })
      .catch((err: unknown) => console.warn("[canvas] worktree validation failed", err));
  }, [activeProjectId]);
}
