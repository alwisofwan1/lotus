"use client";
import { useEffect, useRef } from "react";
import { agentRunRegistry, type AgentRunContext, type AgentRunRegistry } from "../services/agent-run-registry";
import type { GraphRunNodeResult } from "../services/graph-run-record";
import type { AgentNodeStatus } from "../types/canvas";

/**
 * Wires one AgentNode into the graph run registry: exposes its start to the
 * runner, and reports the result back — but only for graph-driven runs, so a
 * manual [Run] click never advances the graph. `getResult` lets the node attach
 * its run details (session id, run id) so the graph checkpoint can link them.
 */
export function useAgentRunRegistration(
  id: string,
  status: AgentNodeStatus,
  start: (ctx?: AgentRunContext) => void,
  registry: AgentRunRegistry = agentRunRegistry,
  getResult?: () => GraphRunNodeResult | null,
): void {
  const startRef = useRef(start);
  const getResultRef = useRef(getResult);
  const graphDriven = useRef(false);

  useEffect(() => { startRef.current = start; }, [start]);
  useEffect(() => { getResultRef.current = getResult; }, [getResult]);

  useEffect(
    () => registry.register(id, { run: (ctx) => { graphDriven.current = true; startRef.current(ctx); } }),
    [id, registry],
  );

  useEffect(() => {
    if (!graphDriven.current) return;
    if (status === "completed" || status === "error") {
      registry.reportResult(id, status === "completed", getResultRef.current?.() ?? undefined);
      graphDriven.current = false;
    }
  }, [id, status, registry]);
}
