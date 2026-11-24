import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import { CanvasDrawCapture } from "../CanvasDrawCapture";

const flowInstance = {
  screenToFlowPosition: (p: { x: number; y: number }) => p,
} as unknown as ReactFlowInstance<Node, Edge>;

function setup(shape: "draw" | "rectangle" = "draw") {
  const onCreate = vi.fn();
  const { container } = render(
    <CanvasDrawCapture shape={shape} flowInstance={flowInstance} onCreate={onCreate} />,
  );
  return { onCreate, layer: container.querySelector(".canvas-draw-capture")! as HTMLElement, container };
}

/** A pointermove whose native event carries coalesced samples (120Hz+ pointers batch them). */
function coalescedMove(layer: HTMLElement, samples: Array<{ x: number; y: number }>) {
  const last = samples[samples.length - 1];
  const event = new PointerEvent("pointermove", { clientX: last.x, clientY: last.y, bubbles: true });
  Object.defineProperty(event, "getCoalescedEvents", {
    value: () => samples.map((s) => ({ clientX: s.x, clientY: s.y })),
  });
  fireEvent(layer, event);
}

describe("CanvasDrawCapture freehand", () => {
  it("consumes coalesced pointer samples so fast strokes are not undersampled", () => {
    const { onCreate, layer } = setup("draw");
    fireEvent.pointerDown(layer, { button: 0, clientX: 0, clientY: 0 });
    // one React-level move event carrying the whole 3-sample burst, including the corner
    coalescedMove(layer, [{ x: 50, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }]);
    fireEvent.pointerUp(layer, { clientX: 100, clientY: 100 });
    const [shape, position, size, points] = onCreate.mock.calls[0];
    expect(shape).toBe("draw");
    expect(position).toEqual({ x: 0, y: 0 });
    expect(size).toEqual({ w: 100, h: 100 });
    // the corner at (100,0) only exists inside the coalesced batch — it must survive
    expect(points).toContainEqual([1, 0]);
  });

  it("simplifies the committed trail: collinear samples collapse, corners survive", () => {
    const { onCreate, layer } = setup("draw");
    fireEvent.pointerDown(layer, { button: 0, clientX: 0, clientY: 0 });
    coalescedMove(layer, [{ x: 25, y: 0 }, { x: 50, y: 0 }, { x: 75, y: 0 }]);
    coalescedMove(layer, [{ x: 100, y: 0 }, { x: 100, y: 50 }]);
    fireEvent.pointerUp(layer, { clientX: 100, clientY: 100 });
    const points = onCreate.mock.calls[0][3] as Array<[number, number]>;
    // 8 raw samples → 3 meaningful points: start, corner, end
    expect(points).toEqual([[0, 0], [1, 0], [1, 1]]);
  });

  it("draws the live trail without React re-renders (polyline updated in place)", () => {
    const { layer, container } = setup("draw");
    fireEvent.pointerDown(layer, { button: 0, clientX: 10, clientY: 10 });
    const poly = container.querySelector(".canvas-draw-trail polyline")!;
    coalescedMove(layer, [{ x: 20, y: 20 }]);
    coalescedMove(layer, [{ x: 30, y: 30 }]);
    expect(poly.getAttribute("points")).toBe("10,10 20,20 30,30");
    expect(container.querySelector(".canvas-draw-trail polyline")).toBe(poly); // same element, no remount
  });

  it("still commits a plain drag rectangle", () => {
    const { onCreate, layer } = setup("rectangle");
    fireEvent.pointerDown(layer, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(layer, { clientX: 110, clientY: 60 });
    fireEvent.pointerUp(layer, { clientX: 110, clientY: 60 });
    expect(onCreate).toHaveBeenCalledWith("rectangle", { x: 10, y: 10 }, { w: 100, h: 50 }, undefined);
  });
});
