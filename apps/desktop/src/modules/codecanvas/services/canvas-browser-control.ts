import type { Edge, Node } from "@xyflow/react";

export type CanvasBrowserControlIntent =
  | { kind: "open-or-focus"; terminalId: string; url?: string }
  | { kind: "navigate"; terminalId: string; url: string };

export type CanvasBrowserControlPlan =
  | { kind: "spawn"; terminalId: string; url: string }
  | { kind: "focus"; nodeId: string }
  | { kind: "activate"; nodeId: string; url: string }
  | { kind: "navigate"; nodeId: string; nativeBrowserId: string; url: string }
  /** The intent's terminal is not a node in this project (a foreign/stale event) — do nothing. */
  | { kind: "ignore"; terminalId: string };

export interface CanvasBrowserControlGraph {
  nodes: Pick<Node, "id" | "type" | "data">[];
  edges: Pick<Edge, "source" | "target">[];
}

function findPairedBrowser(
  terminalId: string,
  graph: CanvasBrowserControlGraph,
): CanvasBrowserControlGraph["nodes"][number] | null {
  return graph.nodes.find(
    (node) =>
      node.type === "browser" &&
      graph.edges.some((edge) => edge.source === terminalId && edge.target === node.id),
  ) ?? null;
}

export function findPairedBrowserNode(
  terminalId: string,
  graph: CanvasBrowserControlGraph,
): string | null {
  return findPairedBrowser(terminalId, graph)?.id ?? null;
}

function browserState(node: CanvasBrowserControlGraph["nodes"][number]): string {
  return typeof node.data?.state === "string" ? node.data.state : "disconnected";
}

export function planCanvasBrowserControl(
  intent: CanvasBrowserControlIntent,
  graph: CanvasBrowserControlGraph,
): CanvasBrowserControlPlan {
  const existingBrowser = findPairedBrowser(intent.terminalId, graph);
  const url = "url" in intent ? intent.url : undefined;

  // Cross-project leak guard: if this project has NOTHING to act on — no paired browser AND no node
  // with the event's terminal id — the event belongs to another project (a stale/foreign browser
  // event). Ignore it so we never spawn a foreign project's browser onto the active canvas.
  const terminalExistsHere = graph.nodes.some((node) => node.id === intent.terminalId);
  if (!existingBrowser && !terminalExistsHere) {
    return { kind: "ignore", terminalId: intent.terminalId };
  }

  if (!existingBrowser) {
    return { kind: "spawn", terminalId: intent.terminalId, url: url ?? "about:blank" };
  }

  if (!url) {
    return { kind: "focus", nodeId: existingBrowser.id };
  }

  if (browserState(existingBrowser) !== "active") {
    return { kind: "activate", nodeId: existingBrowser.id, url };
  }

  return {
    kind: "navigate",
    nodeId: existingBrowser.id,
    nativeBrowserId: intent.terminalId,
    url,
  };
}
