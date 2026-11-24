"use client";
import { NodeToolbar, Position } from "@xyflow/react";
import { SquareDashed } from "lucide-react";

interface Props {
  /** The selected nodes the toolbar floats above (Frames excluded by the caller). */
  nodeIds: string[];
  onCreateFrame: () => void;
}

/**
 * "N selected | ▢ Frame ⌘G" above a multi-selection (decision 25, mockup 5a). NodeToolbar anchors
 * to the selection's bounds and follows pan/zoom, so no viewport maths lives here. Rendered as a
 * child of the ReactFlow tree. It is a toolbar, not a menu: it never covers anything the user is
 * working in, so it takes no occlusion lock.
 *
 * occlusion-exempt: a small toolbar anchored to the selection (NodeToolbar), not a modal or a layer
 * over the canvas; it may sit above a Canvas Browser Node it belongs to.
 */
export function CanvasFrameSelectionToolbar({ nodeIds, onCreateFrame }: Props) {
  if (nodeIds.length < 2) return null;
  return (
    <NodeToolbar nodeId={nodeIds} isVisible position={Position.Top} offset={14} className="nodrag nopan">
      <div className="canvas-frame-selbar" role="toolbar" aria-label="Selection" data-testid="frame-selection-toolbar">
        <span className="canvas-frame-selbar-count">{`${nodeIds.length} selected`}</span>
        <button type="button" className="canvas-frame-selbar-btn" onClick={onCreateFrame} title="Group the selection into a Frame (⌘G)">
          <SquareDashed size={14} aria-hidden="true" />
          Frame
          <kbd>⌘G</kbd>
        </button>
      </div>
    </NodeToolbar>
  );
}
