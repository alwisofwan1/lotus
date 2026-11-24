"use client";
import { createContext, useCallback, useContext, type ReactNode } from "react";
import type { Node, Edge } from "@xyflow/react";
import { buildRunGraph } from "../services/canvas-run-scheduler";
import { useCanvasGraphRun, type UseCanvasGraphRunResult } from "../hooks/useCanvasGraphRun";

const NOOP_GRAPH_RUN: UseCanvasGraphRunResult = {
  running: false,
  error: null,
  run: () => {},
  resumable: null,
  resume: () => {},
  resumeWithBudget: () => {},
  replayFrom: () => {},
  replayFromWhenSettled: () => {},
  pause: () => {},
  pausing: false,
  abort: () => {},
  replayable: false,
  latestRun: null,
  lastSummary: null,
};

const CanvasGraphRunContext = createContext<UseCanvasGraphRunResult>(NOOP_GRAPH_RUN);
const CanvasProjectContext = createContext<string | null>(null);

/** A node (e.g. AgentNode) reads the shared run controller to trigger a replay-from-here. */
export function useCanvasGraphRunContext(): UseCanvasGraphRunResult {
  return useContext(CanvasGraphRunContext);
}

/** The active canvas project id — used to scope durable writes (e.g. context bus artifacts). */
export function useCanvasProjectId(): string | null {
  return useContext(CanvasProjectContext);
}

interface Props {
  nodes: Node[];
  edges: Edge[];
  projectId?: string | null;
  children: ReactNode;
}

/**
 * Owns the single graph-run controller for the canvas and shares it with both the
 * floating run control and the agent nodes (so a node can replay from itself).
 */
export function CanvasGraphRunProvider({ nodes, edges, projectId, children }: Props) {
  const buildGraph = useCallback(() => buildRunGraph(nodes, edges), [nodes, edges]);
  const value = useCanvasGraphRun(buildGraph, undefined, "Add at least one agent, team, critic, or human gate to run the graph.", {
    projectId: projectId ?? undefined,
  });
  return (
    <CanvasProjectContext.Provider value={projectId ?? null}>
      <CanvasGraphRunContext.Provider value={value}>
        {children}
      </CanvasGraphRunContext.Provider>
    </CanvasProjectContext.Provider>
  );
}
