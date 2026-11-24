import { Position } from "@xyflow/react";

export interface CanvasFloatingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasFloatingPoint {
  x: number;
  y: number;
}

export interface FloatingEdgeOptions {
  /** Distance from the node perimeter. Keeps wires outside the node chrome. */
  offset?: number;
}

export interface CanvasFloatingEdgeParams {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
}

interface InternalNodeLike {
  internals?: { positionAbsolute?: { x?: number; y?: number } };
  measured?: { width?: number; height?: number };
  width?: number | string | null;
  height?: number | string | null;
  style?: { width?: number | string; height?: number | string };
}

const DEFAULT_OFFSET = 10;

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function center(rect: CanvasFloatingRect): CanvasFloatingPoint {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function rectSideIntersection(
  rect: CanvasFloatingRect,
  toward: CanvasFloatingPoint,
  offset: number,
): CanvasFloatingPoint & { position: Position } {
  const c = center(rect);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;

  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
    return { x: rect.x + rect.width + offset, y: c.y, position: Position.Right };
  }

  const halfWidth = Math.max(rect.width / 2, 1);
  const halfHeight = Math.max(rect.height / 2, 1);
  const scaleX = Math.abs(dx) < 0.001 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx);
  const scaleY = Math.abs(dy) < 0.001 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy);
  const hitsVerticalSide = scaleX <= scaleY;
  const scale = hitsVerticalSide ? scaleX : scaleY;

  const edgeX = c.x + dx * scale;
  const edgeY = c.y + dy * scale;

  if (hitsVerticalSide) {
    const right = dx >= 0;
    return {
      x: right ? rect.x + rect.width + offset : rect.x - offset,
      y: clamp(edgeY, rect.y, rect.y + rect.height),
      position: right ? Position.Right : Position.Left,
    };
  }

  const bottom = dy >= 0;
  return {
    x: clamp(edgeX, rect.x, rect.x + rect.width),
    y: bottom ? rect.y + rect.height + offset : rect.y - offset,
    position: bottom ? Position.Bottom : Position.Top,
  };
}

export function getFloatingNodeRect(node: InternalNodeLike | null | undefined): CanvasFloatingRect | null {
  if (!node) return null;
  const x = numeric(node.internals?.positionAbsolute?.x);
  const y = numeric(node.internals?.positionAbsolute?.y);
  const width = numeric(node.measured?.width) ?? numeric(node.width) ?? numeric(node.style?.width);
  const height = numeric(node.measured?.height) ?? numeric(node.height) ?? numeric(node.style?.height);

  if (x == null || y == null || width == null || height == null || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

export function getFloatingEdgeParams(
  sourceRect: CanvasFloatingRect,
  targetRect: CanvasFloatingRect,
  options: FloatingEdgeOptions = {},
): CanvasFloatingEdgeParams {
  const offset = options.offset ?? DEFAULT_OFFSET;
  const sourceCenter = center(sourceRect);
  const targetCenter = center(targetRect);
  const source = rectSideIntersection(sourceRect, targetCenter, offset);
  const target = rectSideIntersection(targetRect, sourceCenter, offset);

  return {
    sourceX: source.x,
    sourceY: source.y,
    targetX: target.x,
    targetY: target.y,
    sourcePosition: source.position,
    targetPosition: target.position,
  };
}

export function getFloatingConnectionParams(
  sourceRect: CanvasFloatingRect,
  targetPoint: CanvasFloatingPoint,
  targetRect: CanvasFloatingRect | null = null,
  options: FloatingEdgeOptions = {},
): CanvasFloatingEdgeParams {
  const offset = options.offset ?? DEFAULT_OFFSET;
  const sourceToward = targetRect ? center(targetRect) : targetPoint;
  const source = rectSideIntersection(sourceRect, sourceToward, offset);

  if (!targetRect) {
    return {
      sourceX: source.x,
      sourceY: source.y,
      targetX: targetPoint.x,
      targetY: targetPoint.y,
      sourcePosition: source.position,
      targetPosition: oppositePosition(source.position),
    };
  }

  const target = rectSideIntersection(targetRect, center(sourceRect), offset);
  return {
    sourceX: source.x,
    sourceY: source.y,
    targetX: target.x,
    targetY: target.y,
    sourcePosition: source.position,
    targetPosition: target.position,
  };
}

function oppositePosition(position: Position): Position {
  if (position === Position.Left) return Position.Right;
  if (position === Position.Right) return Position.Left;
  if (position === Position.Top) return Position.Bottom;
  return Position.Top;
}
