import type { Edge, Node, XYPosition } from "@xyflow/react";
import { getNodeSize } from "../canvas-node-placement";
import { buildCanvasWireEdge } from "../canvas-wire-style";
import { inferEdgeKind } from "../canvas-edge-semantics";

/** Space between the note's right edge and the agent it spawns. */
export const NOTE_AGENT_GAP = 80;

/** Where a note's "Agent" chip puts the new agent: beside the note, top edges aligned. */
export function noteAgentSpawnPosition(note: Node): XYPosition {
  return { x: note.position.x + getNodeSize(note).w + NOTE_AGENT_GAP, y: note.position.y };
}

/**
 * The wire from the note to the agent it spawned. Its kind is whatever a hand-drawn note→agent
 * wire gets (`context`), so the agent reads the note exactly as if the user had wired it.
 */
export function noteAgentWire(noteId: string, agentId: string): Edge {
  return buildCanvasWireEdge({ source: noteId, target: agentId, kind: inferEdgeKind("note", "agent"), animated: true });
}
