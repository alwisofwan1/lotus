"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Node } from "@xyflow/react";
import type { AgentWatchHost, Watch } from "@/modules/automation";
import { agentStatusRegistry, type AgentStatusSnapshot } from "../services/agent-status-registry";
import type { CanvasCommand, CanvasCommandResult } from "../services/commands/canvas-command";
import { buildSpawnFirstAgentDefinition } from "../services/spawn-first-agent";
import { currentNamePool } from "@/lib/agent-naming";

/**
 * Which agents wait on the person: a `needs-you` (a permission prompt, from Claude's `needs-input`
 * hook) or `idle` after having run — the agent ended its turn on a question it asked in prose. An
 * `idle` that never ran is a pane still launching, not an ask.
 */
export function askingAgentIds(snapshots: readonly AgentStatusSnapshot[], ran: Set<string>): Set<string> {
  const asking = new Set<string>();
  for (const snapshot of snapshots) {
    if (snapshot.status === "running") ran.add(snapshot.id);
    if (snapshot.status === "needs-you" || (snapshot.status === "idle" && ran.has(snapshot.id))) asking.add(snapshot.id);
  }
  return asking;
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((id) => b.has(id));

/**
 * The canvas side of the Dock's New page (16e v2): opens the agent, flies to it, and keeps the
 * watch across a closed Dock, which unmounts the surface. The Dock stays open while the agent
 * works; when it asks, `answer` steps the Dock aside as the old hand-off did, because `fitView`
 * centres on the whole pane and the terminal can land behind the Dock.
 */
export function useAutomationAgentWatch({
  nodes,
  runCanvasCommand,
  teamLabel,
  focusNode,
  closeDock,
}: {
  nodes: Node[];
  runCanvasCommand: (command: CanvasCommand) => CanvasCommandResult | undefined | void;
  teamLabel: string | undefined;
  focusNode: (nodeId: string) => void;
  closeDock: () => void;
}): AgentWatchHost {
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const [kept, setKept] = useState<Watch | null>(null);
  const [asking, setAsking] = useState<Set<string>>(() => new Set());
  const ranRef = useRef(new Set<string>());

  useEffect(() => {
    const read = (snapshots: AgentStatusSnapshot[]) => {
      const next = askingAgentIds(snapshots, ranRef.current);
      setAsking((prev) => (sameSet(prev, next) ? prev : next));
    };
    read(agentStatusRegistry.list());
    return agentStatusRegistry.subscribe(read);
  }, []);

  return useMemo<AgentWatchHost>(
    () => ({
      create: async (prompt) => {
        const definition = buildSpawnFirstAgentDefinition(
          "claude",
          nodesRef.current.filter((node) => node.type === "agent").map((node) => String((node.data as { name?: string }).name ?? "")),
          { pool: currentNamePool() },
        );
        const result = runCanvasCommand({ kind: "create-agent", definition, brief: prompt, options: { teamLabel } });
        if (!result?.nodeId) return { error: result?.error ?? "Lotus could not place an agent on this canvas." };
        return { id: result.nodeId, name: definition.name };
      },
      show: (id) => focusNode(id),
      answer: (id) => {
        closeDock();
        focusNode(id);
      },
      close: (id) => runCanvasCommand({ kind: "close-node", nodeId: id }),
      alive: (id) => nodesRef.current.some((node) => node.id === id),
      asking: (id) => asking.has(id),
      kept,
      keep: setKept,
    }),
    // A new identity when a node comes or goes, so the Dock re-reads `alive`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runCanvasCommand, teamLabel, focusNode, closeDock, nodes.length, asking, kept],
  );
}
