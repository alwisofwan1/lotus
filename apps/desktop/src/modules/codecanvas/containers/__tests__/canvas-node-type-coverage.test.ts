import { describe, it, expect } from "vitest";
import { CANVAS_NODE_TYPES } from "../canvas-flow-config";
import { CANVAS_PERSISTED_NODE_TYPES } from "../../services/canvas-snapshot-codec";

describe("every node a board can hold can also be drawn", () => {
  /**
   * The two lists are edited in different files and nothing connects them, so adding a node type
   * to one and forgetting the other is a one-line mistake with a silent failure: ReactFlow falls
   * back to its own default node, and the board reopens with an anonymous little box where a
   * terminal, a music player or an adopted cell used to be. The snapshot is perfectly valid, so
   * nothing logs and nothing fails — it only looks wrong, once, on somebody's saved canvas.
   *
   * The reverse direction is deliberately not asserted: `skills` and `skill` have components and
   * are excluded from snapshots on purpose (`canvas-serialize.ts`).
   */
  it("gives every persisted node type a component", () => {
    const missing = [...CANVAS_PERSISTED_NODE_TYPES].filter((type) => !(type in CANVAS_NODE_TYPES));
    expect(missing).toEqual([]);
  });
});
