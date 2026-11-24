import type { Edge, Node } from "@xyflow/react";
import { inferEdgeKind } from "../canvas-edge-semantics";
import { buildCanvasWireEdge } from "../canvas-wire-style";

export interface FileBoardLinkDeps {
  /** Adds a File Node for the path, or returns the id of the one already on the board. */
  addFileNode: (path: string) => string;
  nodes: () => readonly Node[];
  edges: () => readonly Edge[];
  appendEdges: (edges: Edge[]) => void;
  closeDock: () => void;
  reveal: (primaryNodeId: string, alsoShowIds?: readonly string[]) => void;
}

/**
 * The return path between Code (in the Dock) and the board, and the agent link (plans/canvas-code, S4).
 * Both entry points reuse a File Node that is already on the board for the path.
 */
export function createFileBoardLinks(deps: FileBoardLinkDeps) {
  return {
    /** Code's "Show on board": fly to the file's node, making it first when there is none. */
    showOnBoard(path: string): void {
      const id = deps.addFileNode(path);
      deps.closeDock();
      deps.reveal(id);
    },
    /** An agent's touched-file "Open file on board": the node, wired to that agent as context. */
    openFromAgent(path: string, agentNodeId: string): void {
      const fileId = deps.addFileNode(path);
      const alreadyWired = deps.edges().some((e) => e.source === fileId && e.target === agentNodeId);
      if (!alreadyWired) {
        const agentType = deps.nodes().find((n) => n.id === agentNodeId)?.type;
        deps.appendEdges([buildCanvasWireEdge({ source: fileId, target: agentNodeId, kind: inferEdgeKind("file", agentType), animated: true })]);
      }
      deps.closeDock();
      deps.reveal(fileId, [agentNodeId]);
    },
  };
}
