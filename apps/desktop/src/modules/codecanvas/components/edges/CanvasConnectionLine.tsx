"use client";
import { memo } from "react";
import {
  getBezierPath,
  type ConnectionLineComponentProps,
} from "@xyflow/react";
import { getFloatingConnectionParams, getFloatingNodeRect } from "../../services/canvas-floating-edge";

export const CanvasConnectionLine = memo(function CanvasConnectionLine(props: ConnectionLineComponentProps) {
  const sourceRect = getFloatingNodeRect(props.fromNode);
  const targetRect = getFloatingNodeRect(props.toNode);
  const edgePosition = sourceRect
    ? getFloatingConnectionParams(sourceRect, { x: props.toX, y: props.toY }, targetRect)
    : {
        sourceX: props.fromX,
        sourceY: props.fromY,
        sourcePosition: props.fromPosition,
        targetX: props.toX,
        targetY: props.toY,
        targetPosition: props.toPosition,
      };
  const [path, labelX, labelY] = getBezierPath(edgePosition);
  const status = props.connectionStatus ?? (props.toNode ? "valid" : "idle");
  const label = status === "invalid" ? "Unavailable" : props.toNode ? "Release to connect" : "Choose a target";

  return (
    <g className="canvas-connection-line" data-status={status}>
      <path className="canvas-connection-line-path" d={path} />
      <foreignObject
        x={labelX - 68}
        y={labelY - 14}
        width={136}
        height={28}
        className="canvas-connection-line-label-host"
      >
        <div className="canvas-connection-line-label">{label}</div>
      </foreignObject>
    </g>
  );
});
