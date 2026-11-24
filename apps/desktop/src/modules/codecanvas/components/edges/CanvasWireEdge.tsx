"use client";
import { memo, useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  BaseEdge,
  EdgeToolbar,
  getBezierPath,
  useInternalNode,
  type EdgeProps,
} from "@xyflow/react";
import { getFloatingEdgeParams, getFloatingNodeRect } from "../../services/canvas-floating-edge";

export interface CanvasWireEdgeData extends Record<string, unknown> {
  onDelete?: (edgeId: string) => void;
  onLabelChange?: (edgeId: string, label: string) => void;
}

export const CanvasWireEdge = memo(function CanvasWireEdge(props: EdgeProps) {
  const {
    id,
    selected,
    label,
    markerEnd,
    interactionWidth,
    style,
    data,
  } = props;
  const edgeData = useMemo(() => (data ?? {}) as CanvasWireEdgeData, [data]);
  const sourceNode = useInternalNode(props.source);
  const targetNode = useInternalNode(props.target);
  const sourceRect = getFloatingNodeRect(sourceNode);
  const targetRect = getFloatingNodeRect(targetNode);
  const edgePosition = sourceRect && targetRect
    ? getFloatingEdgeParams(sourceRect, targetRect)
    : props;
  const [edgePath, labelX, labelY] = getBezierPath(edgePosition);

  const currentLabel = typeof label === "string" ? label : "";
  const [draft, setDraft] = useState(currentLabel);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync draft when the edge label changes (e.g. external patch or initial load)
  useEffect(() => { setDraft(currentLabel); }, [currentLabel]);

  const commit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed !== currentLabel) {
      edgeData.onLabelChange?.(id, trimmed);
    }
  }, [draft, currentLabel, edgeData, id]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); inputRef.current?.blur(); }
    if (e.key === "Escape") { setDraft(currentLabel); inputRef.current?.blur(); }
  }, [commit, currentLabel]);

  return (
    <>
      {/* Only BaseEdge-valid props — spreading all EdgeProps leaks `animated`/`source`/… onto the SVG <path>. */}
      <BaseEdge id={id} path={edgePath} label={label} labelX={labelX} labelY={labelY} markerEnd={markerEnd} interactionWidth={interactionWidth} style={style} />
      <EdgeToolbar edgeId={id} x={labelX} y={labelY} isVisible={!!selected}>
        <div className="canvas-wire-toolbar nodrag nopan nowheel">
          <input
            ref={inputRef}
            type="text"
            className="canvas-wire-label-input"
            value={draft}
            placeholder="label…"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={handleKeyDown}
            aria-label="Edge label"
          />
          <button
            type="button"
            className="canvas-wire-delete-button nodrag nopan nowheel"
            aria-label="Delete wire"
            title="Delete wire"
            onClick={() => edgeData.onDelete?.(id)}
          >
            ×
          </button>
        </div>
      </EdgeToolbar>
    </>
  );
});
