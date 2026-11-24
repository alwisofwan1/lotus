import { useCallback, useRef } from "react";
import type { Edge, Node } from "@xyflow/react";
import { buildCanvasWireEdge } from "../services/canvas-wire-style";
import { browserNode } from "../services/canvas-node-factory";
import { cascadePosition, childPositionRightOf, DEFAULT_BROWSER_SIZE } from "../services/canvas-node-placement";

interface BrowserNodesInput {
  appendNode: (node: Node) => void;
  appendChildNode: (node: Node, edge: Edge) => void;
  nodesRef: { current: Node[] };
  edgesRef: { current: Edge[] };
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  autosaveRef: { current: (nodes: Node[], edges: Edge[]) => void };
}

export function useCanvasBrowserNodes({
  appendNode,
  appendChildNode,
  nodesRef,
  edgesRef,
  setNodes,
  setEdges,
  autosaveRef,
}: BrowserNodesInput) {
  const browserCounterRef = useRef(0);

  const spawnBrowserNode = useCallback(
    (parentTerminalId: string, url: string) => {
      // One-to-one: if a browser node wired from this terminal already exists, focus it.
      const existing = nodesRef.current.find(
        (n) =>
          n.type === "browser" &&
          edgesRef.current.some(
            (e) => e.source === parentTerminalId && e.target === n.id,
          ),
      );
      if (existing) {
        setNodes((nds) =>
          nds.map((n) => (n.id === existing.id ? { ...n, selected: true } : n.selected ? { ...n, selected: false } : n)),
        );
        return existing.id;
      }

      browserCounterRef.current += 1;
      const id = crypto.randomUUID();
      const parent = nodesRef.current.find((n) => n.id === parentTerminalId);
      const pos = childPositionRightOf(parent, DEFAULT_BROWSER_SIZE, nodesRef.current, nodesRef.current.length);

      appendChildNode(
        browserNode({ id, position: pos, parentTerminalId, url, browserNumber: browserCounterRef.current }),
        buildCanvasWireEdge({ source: parentTerminalId, target: id, kind: "browser-spawn", animated: true }),
      );
      return id;
    },
    [appendChildNode, nodesRef, edgesRef, setNodes],
  );

  const closeBrowserNode = useCallback(
    (nodeId: string) => {
      const nextEdges = edgesRef.current.filter(
        (e) => e.source !== nodeId && e.target !== nodeId,
      );
      setEdges(nextEdges);
      setNodes((nds) => {
        const next = nds.filter((n) => n.id !== nodeId);
        autosaveRef.current(next, nextEdges);
        return next;
      });
    },
    [edgesRef, setEdges, setNodes, autosaveRef],
  );

  const spawnStandaloneBrowserNode = useCallback(
    (url: string) => {
      browserCounterRef.current += 1;
      const id = crypto.randomUUID();
      const pos = cascadePosition(nodesRef.current.length);
      appendNode(
        browserNode({ id, position: pos, parentTerminalId: null, url, browserNumber: browserCounterRef.current }),
      );
      return id;
    },
    [appendNode, nodesRef],
  );

  return { browserCounterRef, spawnBrowserNode, spawnStandaloneBrowserNode, closeBrowserNode };
}
