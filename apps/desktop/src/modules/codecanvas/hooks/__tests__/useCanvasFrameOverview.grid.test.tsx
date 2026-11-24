import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import { useCanvasFrameOverview } from "../useCanvasFrameOverview";
import { canvasFrameOverviewStore } from "../../services/canvas-frame-overview-store";

const frame = (id: string, x = 0): Node => ({ id, type: "frame", position: { x, y: 0 }, width: 800, height: 600, data: { title: id } });
const win = (id: string, frameId: string): Node => ({ id, type: "terminal", position: { x: 0, y: 0 }, width: 300, height: 200, data: { frameId } });

beforeEach(() => {
  const pane = document.createElement("div");
  pane.className = "react-flow";
  pane.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1400, bottom: 900, width: 1400, height: 900, toJSON: () => ({}) });
  document.body.appendChild(pane);
});
afterEach(() => {
  canvasFrameOverviewStore.close();
  document.body.innerHTML = "";
});

function setup(nodes: Node[], extra: Record<string, unknown> = {}) {
  const flow = { getViewport: vi.fn(() => ({ x: 5, y: 6, zoom: 1 })), setViewport: vi.fn(async () => true) };
  const focusFrame = vi.fn();
  const snapFrameGrid = vi.fn(() => ({ bounds: { minX: 0, minY: -88, width: 2600, height: 1800 } }));
  const hook = renderHook(() =>
    useCanvasFrameOverview({
      flowInstance: flow as never,
      nodes,
      statuses: [],
      zoomBounds: { minZoom: 0.1, maxZoom: 2 },
      canvasKey: "c",
      focusFrame,
      snapFrameGrid,
      activeFrameId: () => "b",
      ...extra,
    }),
  );
  return { flow, focusFrame, snapFrameGrid, ...hook };
}

describe("Frame Overview + Frame Grid (decisions 43-45)", () => {
  const nodes = [frame("a"), frame("b", 3000), win("m1", "a")];

  it("snaps the Frames into the grid when it opens and fits the camera to the GRID, with even margin", () => {
    const { result, snapFrameGrid, flow } = setup(nodes);
    act(() => result.current.toggle());
    expect(snapFrameGrid).toHaveBeenCalledTimes(1);
    const target = (flow.setViewport.mock.calls[0] as unknown as [{ x: number; y: number; zoom: number }])[0];
    // Visible area: 1400-80-28 wide, 900-60-92 tall (no hint pill, decision 46); margin 20 each side.
    const area = { left: 80, top: 60, width: 1292, height: 748 };
    const fitZoom = Math.min((area.width - 40) / 2600, (area.height - 40) / 1800);
    expect(target.zoom).toBeCloseTo(fitZoom, 5);
    // Centred in the area: equal slack left and right of the grid.
    const slackL = 0 * target.zoom + target.x - area.left;
    const slackR = area.left + area.width - (target.x + 2600 * target.zoom);
    expect(slackL).toBeCloseTo(slackR, 3);
  });

  it("lights the ACTIVE Frame first, and allows live content within the node budget", () => {
    const { result } = setup(nodes);
    act(() => result.current.toggle());
    expect(canvasFrameOverviewStore.get().focusedId).toBe("b");
    expect(canvasFrameOverviewStore.get().fullDetail).toBe(true);
  });

  it("keeps the glyph LOD above 16 window nodes", () => {
    const many = [frame("a"), ...Array.from({ length: 17 }, (_, i) => win(`w${i}`, "a"))];
    const { result } = setup(many);
    act(() => result.current.toggle());
    expect(canvasFrameOverviewStore.get().fullDetail).toBe(false);
  });

  it("Esc returns to the active Frame, because the grid moved the Frames under the old viewport", () => {
    const { result, focusFrame, flow } = setup(nodes);
    act(() => result.current.toggle());
    flow.setViewport.mockClear();
    act(() => result.current.exit());
    expect(focusFrame).toHaveBeenCalledWith("b");
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it("swap forwards both Frame ids to the grid snap while open", () => {
    const { result, snapFrameGrid } = setup(nodes);
    act(() => result.current.swap("a", "b"));
    expect(snapFrameGrid).not.toHaveBeenCalled(); // closed: nothing to swap
    act(() => result.current.toggle());
    act(() => result.current.swap("a", "b"));
    expect(snapFrameGrid).toHaveBeenLastCalledWith(["a", "b"]);
  });

  it("without a grid snap it fits the Frames where they are, as before", () => {
    const { result, flow } = setup(nodes, { snapFrameGrid: undefined });
    act(() => result.current.toggle());
    expect(flow.setViewport).toHaveBeenCalledTimes(1);
    flow.setViewport.mockClear();
    act(() => result.current.exit());
    expect(flow.setViewport).toHaveBeenCalledWith({ x: 5, y: 6, zoom: 1 }, expect.anything());
  });
});
