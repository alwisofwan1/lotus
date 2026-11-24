import type { Node } from "@xyflow/react";
import type { VoiceTurnTarget } from "@/modules/voice-core/voice-adapter";
import { buildNodeIndex } from "../canvas-nl-command";
import { agentStatusRegistry } from "../agent-status-registry";
import { buildCanvasVoiceContext, type CanvasVoiceContext } from "./canvas-voice-context";
import { noteSelectionRegistry } from "./note-selection-registry";

/**
 * Build the Canvas Voice Context (ADR-0034) from ReactFlow nodes + live agent roster.
 *
 * Shared by typed-submit and push-to-talk voice routing so Focused Node, note selection, and live
 * agent naming semantics stay identical. Components should call this adapter instead of rebuilding
 * the node-index/name map inline.
 */
export function buildCanvasVoiceContextFromNodes(
  nodes: Node[],
  roster: ReturnType<typeof agentStatusRegistry.list>,
  /** Read as if this node were the one selected (null: none). Omitted: the board's own selection. */
  focusOn?: VoiceTurnTarget | null,
): CanvasVoiceContext {
  const read = focusOn === undefined ? nodes : nodes.map((node) => ({ ...node, selected: node.id === focusOn?.id }));
  const index = buildNodeIndex(read);
  const nameById = new Map(index.map((r) => [r.id, r.name] as const));
  return buildCanvasVoiceContext(
    read.map((n) => ({
      id: n.id,
      kind: n.type ?? "",
      name: nameById.get(n.id) ?? "",
      selected: !!n.selected,
      selectedText: n.selected && n.type === "note" ? noteSelectionRegistry.selectedText(n.id) : undefined,
    })),
    roster,
  );
}
