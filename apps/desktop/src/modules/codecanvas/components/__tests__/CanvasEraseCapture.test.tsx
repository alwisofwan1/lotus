import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import { CanvasEraseCapture } from "../CanvasEraseCapture";

const flowInstance = {
  screenToFlowPosition: (p: { x: number; y: number }) => p,
} as unknown as ReactFlowInstance<Node, Edge>;

const NODES = [
  { id: "a", position: { x: 0, y: 0 }, width: 100, height: 100 },
  { id: "b", position: { x: 200, y: 0 }, width: 100, height: 100 },
];

/** Stand-ins for the ReactFlow node wrappers the capture layer dims during a stroke. */
function mountWrappers(ids: string[]): HTMLElement[] {
  return ids.map((id) => {
    const el = document.createElement("div");
    el.className = "react-flow__node";
    el.setAttribute("data-id", id);
    document.body.appendChild(el);
    return el;
  });
}

afterEach(() => {
  cleanup();
  document.querySelectorAll(".react-flow__node").forEach((el) => el.remove());
});

describe("CanvasEraseCapture — mark then commit", () => {
  it("marks shapes during the stroke and only deletes on release", () => {
    const [wrapA, wrapB] = mountWrappers(["a", "b"]);
    const onErase = vi.fn();
    const { container } = render(
      <CanvasEraseCapture nodes={NODES} flowInstance={flowInstance} onErase={onErase} />,
    );
    const layer = container.querySelector(".canvas-erase-capture")!;
    fireEvent.pointerDown(layer, { button: 0, clientX: 50, clientY: 50 });
    expect(onErase).not.toHaveBeenCalled(); // nothing deleted mid-stroke
    expect(wrapA.classList.contains("canvas-erase-marked")).toBe(true);
    fireEvent.pointerMove(layer, { clientX: 250, clientY: 50 });
    expect(wrapB.classList.contains("canvas-erase-marked")).toBe(true);
    expect(onErase).not.toHaveBeenCalled();
    fireEvent.pointerUp(layer, { clientX: 250, clientY: 50 });
    expect(onErase.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "b"]);
    expect(wrapA.classList.contains("canvas-erase-marked")).toBe(false);
    expect(wrapB.classList.contains("canvas-erase-marked")).toBe(false);
  });

  it("deletes nothing when the stroke never touches a shape", () => {
    mountWrappers(["a", "b"]);
    const onErase = vi.fn();
    const { container } = render(
      <CanvasEraseCapture nodes={NODES} flowInstance={flowInstance} onErase={onErase} />,
    );
    const layer = container.querySelector(".canvas-erase-capture")!;
    fireEvent.pointerDown(layer, { button: 0, clientX: 150, clientY: 150 });
    fireEvent.pointerUp(layer, { clientX: 150, clientY: 150 });
    expect(onErase).not.toHaveBeenCalled();
  });

  it("Escape cancels the stroke: marks clear and nothing is deleted", () => {
    const [wrapA] = mountWrappers(["a", "b"]);
    const onErase = vi.fn();
    const { container } = render(
      <CanvasEraseCapture nodes={NODES} flowInstance={flowInstance} onErase={onErase} />,
    );
    const layer = container.querySelector(".canvas-erase-capture")!;
    fireEvent.pointerDown(layer, { button: 0, clientX: 50, clientY: 50 });
    expect(wrapA.classList.contains("canvas-erase-marked")).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(wrapA.classList.contains("canvas-erase-marked")).toBe(false);
    fireEvent.pointerUp(layer, { clientX: 50, clientY: 50 });
    expect(onErase).not.toHaveBeenCalled();
  });
});
