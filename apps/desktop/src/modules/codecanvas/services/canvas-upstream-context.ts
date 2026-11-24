import type { Node, Edge } from "@xyflow/react";
import type { AgentContextSource } from "./agent-run-prompt";
import { canvasHandoffStore } from "./canvas-handoff-store";
import { contextBusRegistry } from "./context-bus-registry";
import { isStale } from "./context-bus-record";
import { extractNoteAssetRefs } from "./note-assets";

interface FlowReader {
  getEdges: () => Edge[];
  getNode: (id: string) => Node | undefined;
}

/**
 * The context an agent or critic reads from its upstream neighbours at run time:
 * Note content (static), an upstream Agent's handoff artifact (N2), and every artifact on a
 * connected Context Bus (N3, flagged stale when produced in a different run). Shared by
 * AgentNode and CriticNode so both resolve upstream input identically.
 */
export function resolveUpstreamContext(flow: FlowReader, nodeId: string, activeGraphRunId?: string | null): AgentContextSource[] {
  return flow.getEdges()
    .filter((e) => e.target === nodeId)
    .flatMap((e): AgentContextSource[] => {
      const n = flow.getNode(e.source);
      if (!n) return [];
      if (n.type === "agent") {
        const handoff = canvasHandoffStore.get(n.id);
        return [{ type: "handoff", name: (n.data as { name?: string }).name, content: handoff?.summary }];
      }
      // An upstream critic hands over its review (#112), so a critic after a critic has input to judge.
      if (n.type === "critic") {
        const handoff = canvasHandoffStore.get(n.id);
        return [{ type: "handoff", name: (n.data as { title?: string }).title, content: handoff?.summary }];
      }
      if (n.type === "context") {
        return contextBusRegistry.list(n.id).map((a) => ({
          type: "context", key: a.key, name: a.producer, content: a.value,
          stale: isStale(a, activeGraphRunId ?? null),
        }));
      }
      if (n.type === "note") {
        const content = (n.data as { content?: unknown }).content;
        const markdown = typeof content === "string" ? content : "";
        return [{ type: "note", content, assets: extractNoteAssetRefs(markdown) }];
      }
      // A File Node hands over where the file is, never what is in it: the agent reads the disk itself.
      if (n.type === "file") {
        const path = (n.data as { path?: unknown }).path;
        return typeof path === "string" && path ? [{ type: "file", path }] : [];
      }
      return [{ type: n.type, content: (n.data as { content?: unknown }).content }];
    });
}
