import { MarkerType, type Edge } from "@xyflow/react";
import { EDGE_KIND_LABEL, isAgentWorkflowKind } from "./canvas-edge-semantics";

export type CanvasWireKind =
  | "default"
  | "skills"
  | "skill-preview"
  | "context"
  | "triggers"
  | "orchestrates"
  | "data-flow"
  | "agent-link"
  | "browser-spawn"
  | "connector";

const WIRE_CLASS_BY_KIND: Record<CanvasWireKind, string> = {
  default: "canvas-wire--default",
  skills: "canvas-wire--skills",
  "skill-preview": "canvas-wire--skill-preview",
  context: "canvas-wire--context",
  triggers: "canvas-wire--triggers",
  orchestrates: "canvas-wire--orchestrates",
  "data-flow": "canvas-wire--data-flow",
  "agent-link": "canvas-wire--agent-link",
  "browser-spawn": "canvas-wire--browser-spawn",
  connector: "canvas-wire--connector",
};

const MARKER_COLOR_BY_KIND: Partial<Record<CanvasWireKind, string>> = {
  context: "rgba(251, 191, 36, 0.86)",
  triggers: "rgba(52, 211, 153, 0.88)",
  orchestrates: "rgba(165, 180, 252, 0.9)",
  "data-flow": "rgba(251, 191, 36, 0.88)",
  "agent-link": "rgba(196, 181, 253, 0.82)",
  connector: "rgba(217, 214, 207, 0.85)",
};

/** Diagram connectors aren't workflow/execution edges, but they still need a directional arrowhead. */
function wantsArrowhead(kind: CanvasWireKind): boolean {
  return isAgentWorkflowKind(kind) || kind === "connector";
}

export interface BuildCanvasWireEdgeInput {
  id?: string;
  source: string;
  target: string;
  kind?: CanvasWireKind;
  animated?: boolean;
  /** Explicit label override. undefined = use kind default; "" = no label; string = show that string. */
  label?: string;
  /** Which side-handle each end attaches to (ConnectionMode.Loose, 4-side handles). */
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export function canvasWireClassName(kind: CanvasWireKind = "default"): string {
  return `canvas-wire ${WIRE_CLASS_BY_KIND[kind]}`;
}

export function buildCanvasWireEdge({
  id = crypto.randomUUID(),
  source,
  target,
  kind = "default",
  animated = false,
  label: labelOverride,
  sourceHandle,
  targetHandle,
}: BuildCanvasWireEdgeInput): Edge {
  // undefined = use kind's semantic default; explicit string (even "") = use that (suppresses default)
  const resolvedLabel = labelOverride !== undefined ? labelOverride : EDGE_KIND_LABEL[kind];
  const arrowhead = wantsArrowhead(kind);
  return {
    id,
    source,
    target,
    animated,
    type: "canvas-wire",
    className: canvasWireClassName(kind),
    interactionWidth: 24,
    reconnectable: true,
    data: {
      wireKind: kind,
      ...(labelOverride !== undefined ? { customLabel: labelOverride } : {}),
    },
    ...(arrowhead ? { markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: MARKER_COLOR_BY_KIND[kind] } } : {}),
    ...(resolvedLabel ? { label: resolvedLabel } : {}),
    ...(sourceHandle ? { sourceHandle } : {}),
    ...(targetHandle ? { targetHandle } : {}),
  };
}
