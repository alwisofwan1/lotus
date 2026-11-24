import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import { CanvasFrameOverviewLayer } from "../CanvasFrameOverviewLayer";
import { canvasFrameOverviewStore } from "../../services/canvas-frame-overview-store";

vi.mock("@xyflow/react", () => ({
  Panel: ({ children, position, className }: { children: React.ReactNode; position: string; className?: string }) => (
    <div data-testid="panel" data-position={position} className={className}>{children}</div>
  ),
  // Identity mapping: 1 screen px = 1 flow unit.
  useReactFlow: () => ({ screenToFlowPosition: (p: { x: number; y: number }) => p }),
}));
vi.mock("../../hooks/useCanvasOcclusionLock", () => ({ useCanvasOcclusionLock: () => undefined }));

const frame = (id: string, x: number): Node => ({ id, type: "frame", position: { x, y: 0 }, width: 100, height: 100, data: { title: id } });
const nodes: Node[] = [
  frame("a", 0),
  { id: "m1", type: "terminal", position: { x: 0, y: 0 }, data: { frameId: "a" } },
  frame("b", 200),
  { id: "m2", type: "terminal", position: { x: 200, y: 0 }, data: { frameId: "b" } },
  { id: "loose", type: "shape", position: { x: 900, y: 900 }, data: {} },
];

afterEach(() => act(() => canvasFrameOverviewStore.close()));

function setup() {
  const handlers = { onFocus: vi.fn(), onFlyIn: vi.fn(), onSwap: vi.fn(), onExit: vi.fn() };
  const view = render(<CanvasFrameOverviewLayer nodes={nodes} {...handlers} />);
  const layer = view.getByTestId("frame-overview-layer");
  return { ...view, layer, ...handlers };
}

describe("CanvasFrameOverviewLayer (decisions 43-45)", () => {
  it("shows no hint pill: nothing can sit under the command bar or the Top Bar (decision 46)", () => {
    const { queryByTestId } = setup();
    expect(queryByTestId("panel")).toBeNull();
    expect(queryByTestId("frame-overview-hint")).toBeNull();
  });

  it("a plain click flies into the Frame under the pointer", () => {
    const { layer, onFlyIn } = setup();
    fireEvent.pointerDown(layer, { clientX: 50, clientY: 50, button: 0 });
    fireEvent.pointerUp(layer, { clientX: 50, clientY: 50 });
    fireEvent.click(layer, { clientX: 50, clientY: 50 });
    expect(onFlyIn).toHaveBeenCalledWith("a");
  });

  it("dragging one Frame onto another swaps them, shows a ghost while moving, and does not fly in", () => {
    const { layer, onSwap, onFlyIn, queryByTestId } = setup();
    fireEvent.pointerDown(layer, { clientX: 50, clientY: 50, button: 0 });
    fireEvent.pointerMove(layer, { clientX: 150, clientY: 60 });
    expect(queryByTestId("frame-overview-ghost")?.textContent).toBe("a");
    fireEvent.pointerMove(layer, { clientX: 250, clientY: 60 });
    fireEvent.pointerUp(layer, { clientX: 250, clientY: 60 });
    fireEvent.click(layer, { clientX: 250, clientY: 60 });
    expect(onSwap).toHaveBeenCalledWith("a", "b");
    expect(onFlyIn).not.toHaveBeenCalled();
    expect(queryByTestId("frame-overview-ghost")).toBeNull();
  });

  it("dropping a dragged Frame on itself or the gap changes nothing", () => {
    const { layer, onSwap } = setup();
    fireEvent.pointerDown(layer, { clientX: 50, clientY: 50, button: 0 });
    fireEvent.pointerMove(layer, { clientX: 60, clientY: 70 });
    fireEvent.pointerUp(layer, { clientX: 60, clientY: 70 });
    fireEvent.pointerDown(layer, { clientX: 50, clientY: 50, button: 0 });
    fireEvent.pointerMove(layer, { clientX: 150, clientY: 50 });
    fireEvent.pointerUp(layer, { clientX: 150, clientY: 50 });
    expect(onSwap).not.toHaveBeenCalled();
  });

  it("hover lights a Frame and quietly dims every other node, never the lit Frame or its members", () => {
    const { layer, getByTestId, queryByTestId, onFocus } = setup();
    expect(queryByTestId("frame-overview-dim")).toBeNull();
    act(() => canvasFrameOverviewStore.open({}, null));
    fireEvent.pointerMove(layer, { clientX: 50, clientY: 50 });
    expect(onFocus).toHaveBeenCalledWith("a");
    act(() => canvasFrameOverviewStore.focus("a"));
    const css = getByTestId("frame-overview-dim").textContent!;
    expect(css).toContain('[data-id="b"]');
    expect(css).toContain('[data-id="m2"]');
    expect(css).toContain('[data-id="loose"]');
    expect(css).not.toContain('[data-id="a"]');
    expect(css).not.toContain('[data-id="m1"]');
    expect(css).toContain("opacity:0.55");
  });
});
