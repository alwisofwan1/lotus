import type { AgentStatusSnapshot } from "../agent-status-registry";

/**
 * Canvas Voice Context (ADR-0034) — the native, ground-truth snapshot the Voice Intent Router reads
 * to infer a Voice Outcome. Where SuperWhisper's Super Mode must probe the OS via accessibility APIs,
 * Lotus owns this context directly. v1 carries only what routing needs (the Focused Node + selection
 * count); a later pass may enrich it with clipboard, selected note text, and the last agent output tail.
 */

/** Minimal structural subset of an xyflow node the context builder reads. */
export interface VoiceContextNode {
  id: string;
  /** The xyflow node type ("agent" | "terminal" | "browser" | "note" | …). */
  kind: string;
  /** Human-facing name (agent name, note title, …) — the fallback when no live roster entry exists. */
  name: string;
  selected?: boolean;
  /** For a note: the text currently selected in its editor (empty/absent when none). Populated at the
   *  call site from the note-selection registry so this module stays pure. */
  selectedText?: string;
}

/**
 * The single selected canvas node — the anchor the router uses to resolve context-relative targets.
 * `agentId` is set only when the node is an agent (the dictation target); `isLiveAgent` additionally
 * requires a live/dispatchable session, and is used for the chip's tone, not for routing.
 */
export interface FocusedNode {
  nodeId: string;
  kind: string;
  name: string;
  agentId: string | null;
  isLiveAgent: boolean;
  /** Text selected in this node's editor (notes only) — the target of a selected-text transform. */
  selectedText: string;
}

export interface CanvasVoiceContext {
  focus: FocusedNode | null;
  selectionCount: number;
}

/**
 * Build the {@link CanvasVoiceContext} from the current nodes + the live agent roster. Pure. A
 * **Focused Node** exists only when exactly one node is selected (`selectionCount === 1`); a
 * multi-selection deliberately yields no focus so voice never guesses which of many you meant.
 */
export function buildCanvasVoiceContext(
  nodes: readonly VoiceContextNode[],
  roster: readonly AgentStatusSnapshot[],
): CanvasVoiceContext {
  const selected = nodes.filter((n) => n.selected);
  if (selected.length !== 1) return { focus: null, selectionCount: selected.length };

  const node = selected[0];
  const isAgent = node.kind === "agent";
  const live = isAgent ? roster.find((a) => a.id === node.id) : undefined;
  return {
    focus: {
      nodeId: node.id,
      kind: node.kind,
      name: live?.name ?? node.name,
      agentId: isAgent ? node.id : null,
      isLiveAgent: isAgent && !!live?.sessionId,
      selectedText: (node.selectedText ?? "").trim(),
    },
    selectionCount: 1,
  };
}
