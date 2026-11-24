import {
  findPairedBrowserNode,
  planCanvasBrowserControl,
  type CanvasBrowserControlGraph,
} from "./canvas-browser-control";

export type CanvasBrowserApiEvent = {
  kind: "open" | "navigate";
  terminalId: string;
  url: string;
  label?: string;
};

export interface CanvasBrowserApiBridgeDeps {
  nodes: CanvasBrowserControlGraph["nodes"];
  edges: CanvasBrowserControlGraph["edges"];
  spawnBrowserNode: (terminalId: string, url: string) => string;
  patchNodeData: (nodeId: string, patch: Record<string, unknown>) => void;
  navigateBrowser: (nativeBrowserId: string, url: string) => Promise<unknown>;
}

export { findPairedBrowserNode };

export async function handleCanvasBrowserApiEvent(
  event: CanvasBrowserApiEvent,
  deps: CanvasBrowserApiBridgeDeps,
): Promise<string> {
  const plan = planCanvasBrowserControl(
    event.kind === "navigate"
      ? { kind: "navigate", terminalId: event.terminalId, url: event.url }
      : { kind: "open-or-focus", terminalId: event.terminalId, url: event.url },
    deps,
  );
  const label =
    typeof event.label === "string" && event.label.trim()
      ? event.label
      : undefined;
  const labelPatch = label ? { label } : {};
  switch (plan.kind) {
    case "ignore":
      // Foreign/stale event (terminal not in the active project) — do nothing.
      return "";
    case "spawn": {
      const nodeId = deps.spawnBrowserNode(plan.terminalId, plan.url);
      if (label) deps.patchNodeData(nodeId, { label });
      return nodeId;
    }
    case "focus":
      return plan.nodeId;
    case "activate":
      deps.patchNodeData(plan.nodeId, { url: plan.url, state: "loading", ...labelPatch });
      return plan.nodeId;
    case "navigate":
      deps.patchNodeData(plan.nodeId, { url: plan.url, state: "active", ...labelPatch });
      await deps.navigateBrowser(plan.nativeBrowserId, plan.url);
      return plan.nodeId;
  }
}
