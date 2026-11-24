import { Position } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { getFloatingEdgeParams, getFloatingNodeRect } from "../canvas-floating-edge";

describe("canvas floating edge geometry", () => {
  it("connects horizontal nodes from the nearest outside edges", () => {
    const params = getFloatingEdgeParams(
      { x: 0, y: 0, width: 100, height: 80 },
      { x: 240, y: 10, width: 120, height: 80 },
      { offset: 10 },
    );

    expect(params).toMatchObject({
      sourceX: 110,
      sourcePosition: Position.Right,
      targetX: 230,
      targetPosition: Position.Left,
    });
    expect(params.sourceY).toBeGreaterThan(35);
    expect(params.sourceY).toBeLessThan(45);
  });

  it("connects vertical nodes from bottom to top", () => {
    const params = getFloatingEdgeParams(
      { x: 50, y: 20, width: 120, height: 60 },
      { x: 70, y: 220, width: 100, height: 70 },
      { offset: 8 },
    );

    expect(params.sourcePosition).toBe(Position.Bottom);
    expect(params.targetPosition).toBe(Position.Top);
    expect(params.sourceY).toBe(88);
    expect(params.targetY).toBe(212);
  });

  it("derives a node rect from React Flow internal node measurements", () => {
    const rect = getFloatingNodeRect({
      internals: { positionAbsolute: { x: 12, y: 24 } },
      measured: { width: 320, height: 180 },
    });

    expect(rect).toEqual({ x: 12, y: 24, width: 320, height: 180 });
  });
});
