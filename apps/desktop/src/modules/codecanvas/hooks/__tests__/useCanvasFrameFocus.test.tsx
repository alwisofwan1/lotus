import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import { useCanvasFrameFocus } from "../useCanvasFrameFocus";
import { canvasActiveFrameStore } from "../../services/canvas-active-frame";
import { canvasFrameRetileStore } from "../../services/canvas-frame-retile-store";
import { TIDY_DEBOUNCE_MS } from "../../services/canvas-motion";
import { setCanvasBehaviorSetting } from "../useCanvasBehaviorSettings";

const frame = (id: string, x = 0): Node => ({ id, type: "frame", position: { x, y: 0 }, width: 800, height: 600, data: { title: id } });
const win = (id: string, frameId: string): Node => ({ id, type: "terminal", position: { x: 0, y: 0 }, width: 300, height: 200, data: { frameId } });

const BOUNDS = { minX: 0, minY: 0, width: 800, height: 600 };

function setup(initialNodes: Node[] = [frame("a"), frame("b", 2000), win("m1", "a"), win("m2", "a"), win("m3", "b")]) {
  const nodes = { current: initialNodes };
  let viewport = { x: 0, y: 0, zoom: 1 };
  const flow = {
    getViewport: vi.fn(() => viewport),
    setViewport: vi.fn(async (v: typeof viewport) => { viewport = v; return true; }),
    fitBounds: vi.fn(async () => true),
  };
  const arrangeFrameMembers = vi.fn(() => BOUNDS);
  const retileFrameMembers = vi.fn(() => BOUNDS);
  const exitFocus = vi.fn();
  const focusedNodeIdRef = { current: null as string | null };
  const hook = renderHook((props: { nodes: Node[]; boardReady: boolean; canvasKey: string }) => {
    nodes.current = props.nodes;
    return useCanvasFrameFocus({
      flowInstance: flow as never,
      nodes: props.nodes,
      nodesRef: nodes,
      canvasKey: props.canvasKey,
      boardReady: props.boardReady,
      focusedNodeIdRef,
      exitFocus,
      arrangeFrameMembers,
      retileFrameMembers,
    });
  }, { initialProps: { nodes: initialNodes, boardReady: true, canvasKey: "c1" } });
  return { hook, flow, arrangeFrameMembers, retileFrameMembers, exitFocus, focusedNodeIdRef, setViewport: (v: typeof viewport) => { viewport = v; } };
}

beforeEach(() => {
  vi.useFakeTimers();
  canvasActiveFrameStore.reset();
  try { localStorage.clear(); } catch { /* none */ }
  const pane = document.createElement("div");
  pane.className = "react-flow";
  pane.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1400, bottom: 900, width: 1400, height: 900, toJSON: () => ({}) });
  document.body.appendChild(pane);
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("focusFrame", () => {
  it("tiles the Frame's members, frames the camera on them, and makes the Frame active", () => {
    const t = setup();
    act(() => t.hook.result.current.focusFrame("b"));
    expect(t.arrangeFrameMembers).toHaveBeenCalledWith("b", expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }));
    expect(t.flow.setViewport).toHaveBeenCalledTimes(1);
    expect(canvasActiveFrameStore.get("c1")).toBe("b");
  });
  it("a Frame with nothing to tile just gets the camera, and is still active", () => {
    const t = setup();
    t.arrangeFrameMembers.mockReturnValueOnce(null as never);
    act(() => t.hook.result.current.focusFrame("a"));
    expect(t.flow.fitBounds).toHaveBeenCalledTimes(1);
    expect(canvasActiveFrameStore.get("c1")).toBe("a");
  });
  it("leaves node-focus mode first, without restoring the snapshot", () => {
    const t = setup();
    t.focusedNodeIdRef.current = "m1";
    act(() => t.hook.result.current.focusFrame("a"));
    expect(t.exitFocus).toHaveBeenCalledWith({ restore: false });
  });
  it("an unknown Frame does nothing", () => {
    const t = setup();
    act(() => t.hook.result.current.focusFrame("nope"));
    expect(t.flow.setViewport).not.toHaveBeenCalled();
    // Still the upkeep's first-Frame fallback, not "nope".
    expect(canvasActiveFrameStore.get("c1")).toBe("a");
  });
});

describe("member add/close re-tile (decision 39)", () => {
  async function focusAndSettle(t: ReturnType<typeof setup>, id = "a") {
    act(() => t.hook.result.current.focusFrame(id));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    t.arrangeFrameMembers.mockClear();
    t.flow.setViewport.mockClear();
    t.flow.fitBounds.mockClear();
  }

  it("REGRESSION: closing a member while the Frame is focused re-fills the screen and keeps the camera on the Frame (no whole-canvas move)", async () => {
    const t = setup();
    await focusAndSettle(t);
    act(() => canvasFrameRetileStore.request("a"));
    await act(async () => { await vi.advanceTimersByTimeAsync(TIDY_DEBOUNCE_MS + 50); });
    expect(t.arrangeFrameMembers).toHaveBeenCalledTimes(1);
    expect(t.arrangeFrameMembers).toHaveBeenCalledWith("a", expect.anything());
    expect(t.flow.setViewport).toHaveBeenCalledTimes(1);
    expect(t.retileFrameMembers).not.toHaveBeenCalled();
  });

  it("a Frame that is not focused re-tiles inside its box and the camera does not move", async () => {
    const t = setup();
    await focusAndSettle(t, "a");
    act(() => canvasFrameRetileStore.request("b"));
    await act(async () => { await vi.advanceTimersByTimeAsync(TIDY_DEBOUNCE_MS + 50); });
    expect(t.retileFrameMembers).toHaveBeenCalledWith("b");
    expect(t.arrangeFrameMembers).not.toHaveBeenCalled();
    expect(t.flow.setViewport).not.toHaveBeenCalled();
    expect(t.flow.fitBounds).not.toHaveBeenCalled();
  });

  it("after the user pans away, even the once-focused Frame re-tiles in place without moving the camera", async () => {
    const t = setup();
    await focusAndSettle(t, "a");
    t.setViewport({ x: -3000, y: 0, zoom: 0.2 });
    act(() => canvasFrameRetileStore.request("a"));
    await act(async () => { await vi.advanceTimersByTimeAsync(TIDY_DEBOUNCE_MS + 50); });
    expect(t.retileFrameMembers).toHaveBeenCalledWith("a");
    expect(t.flow.setViewport).not.toHaveBeenCalled();
  });

  it("with nothing ever focused, a spawn re-tiles in the Frame and never touches the camera", async () => {
    const t = setup();
    act(() => canvasFrameRetileStore.request("a"));
    await act(async () => { await vi.advanceTimersByTimeAsync(TIDY_DEBOUNCE_MS + 50); });
    expect(t.retileFrameMembers).toHaveBeenCalledWith("a");
    expect(t.flow.setViewport).not.toHaveBeenCalled();
    expect(t.flow.fitBounds).not.toHaveBeenCalled();
  });

  it("coalesces a batch spawn into ONE re-tile", async () => {
    const t = setup();
    await focusAndSettle(t);
    act(() => {
      canvasFrameRetileStore.request("a");
      canvasFrameRetileStore.request("a");
      canvasFrameRetileStore.request("a");
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(TIDY_DEBOUNCE_MS - 100); });
    act(() => canvasFrameRetileStore.request("a"));
    await act(async () => { await vi.advanceTimersByTimeAsync(TIDY_DEBOUNCE_MS - 100); });
    expect(t.arrangeFrameMembers).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(t.arrangeFrameMembers).toHaveBeenCalledTimes(1);
    expect(t.flow.setViewport).toHaveBeenCalledTimes(1);
  });

  it("a re-tile does not request another re-tile (no feedback loop)", async () => {
    const t = setup();
    await focusAndSettle(t);
    const seen = vi.fn();
    const off = canvasFrameRetileStore.subscribe(seen);
    act(() => canvasFrameRetileStore.request("a"));
    await act(async () => { await vi.advanceTimersByTimeAsync(TIDY_DEBOUNCE_MS * 3); });
    off();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(t.arrangeFrameMembers).toHaveBeenCalledTimes(1);
  });

  it("waits out a focus glide that is still running instead of re-tiling through it", async () => {
    const t = setup();
    act(() => t.hook.result.current.focusFrame("a"));
    t.arrangeFrameMembers.mockClear();
    t.flow.setViewport.mockClear();
    // Requested right after the focus: the debounce would fire mid-glide on a slow glide; it must re-arm.
    act(() => canvasFrameRetileStore.request("a"));
    await act(async () => { await vi.advanceTimersByTimeAsync(TIDY_DEBOUNCE_MS + 2000); });
    expect(t.arrangeFrameMembers).toHaveBeenCalledTimes(1);
  });

  it("node-focus mode is left alone", async () => {
    const t = setup();
    await focusAndSettle(t);
    t.focusedNodeIdRef.current = "m1";
    act(() => canvasFrameRetileStore.request("a"));
    await act(async () => { await vi.advanceTimersByTimeAsync(TIDY_DEBOUNCE_MS + 50); });
    expect(t.arrangeFrameMembers).not.toHaveBeenCalled();
    expect(t.retileFrameMembers).not.toHaveBeenCalled();
  });

  it("closing the last member keeps the empty Frame and the camera", async () => {
    const t = setup();
    await focusAndSettle(t);
    t.hook.rerender({ nodes: [frame("a"), frame("b", 2000), win("m3", "b")], boardReady: true, canvasKey: "c1" });
    act(() => canvasFrameRetileStore.request("a"));
    await act(async () => { await vi.advanceTimersByTimeAsync(TIDY_DEBOUNCE_MS + 50); });
    expect(t.arrangeFrameMembers).not.toHaveBeenCalled();
    expect(t.retileFrameMembers).not.toHaveBeenCalled();
    expect(t.flow.setViewport).not.toHaveBeenCalled();
  });

  it("cancels the pending re-tile on unmount", async () => {
    const t = setup();
    await focusAndSettle(t);
    act(() => canvasFrameRetileStore.request("a"));
    t.hook.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(TIDY_DEBOUNCE_MS * 2); });
    expect(t.arrangeFrameMembers).not.toHaveBeenCalled();
    expect(t.retileFrameMembers).not.toHaveBeenCalled();
  });

  it("forgets the focus when the canvas changes", async () => {
    const t = setup();
    await focusAndSettle(t);
    t.hook.rerender({ nodes: [frame("a"), win("m1", "a")], boardReady: true, canvasKey: "c2" });
    act(() => canvasFrameRetileStore.request("a"));
    await act(async () => { await vi.advanceTimersByTimeAsync(TIDY_DEBOUNCE_MS + 50); });
    expect(t.flow.setViewport).not.toHaveBeenCalled();
    expect(t.retileFrameMembers).toHaveBeenCalledWith("a");
  });
});

describe("auto-tidy on open/close (decision 47)", () => {
  const open = { kind: "open" as const, isNote: false };
  const close = { kind: "close" as const, isNote: false };
  afterEach(() => {
    setCanvasBehaviorSetting("tidyMode", "open-close");
  });

  it("REGRESSION: opening a node fills the screen with its Frame and moves the camera there, with nothing focused before", async () => {
    const t = setup();
    act(() => canvasFrameRetileStore.request("a", open));
    await act(async () => { await vi.advanceTimersByTimeAsync(TIDY_DEBOUNCE_MS + 50); });
    expect(t.arrangeFrameMembers).toHaveBeenCalledWith("a", expect.anything());
    expect(t.retileFrameMembers).not.toHaveBeenCalled();
    expect(t.flow.setViewport).toHaveBeenCalledTimes(1);
  });

  it("a node an agent opens in another Frame re-tiles there: the camera and the active Frame stay the user's", async () => {
    const t = setup();
    act(() => canvasFrameRetileStore.request("b", open));
    await act(async () => { await vi.advanceTimersByTimeAsync(TIDY_DEBOUNCE_MS + 50); });
    expect(t.retileFrameMembers).toHaveBeenCalledWith("b");
    expect(t.flow.setViewport).not.toHaveBeenCalled();
    expect(canvasActiveFrameStore.get("c1")).toBe("a");
  });

  it("REGRESSION (no zoom out): closing a member refills only the active Frame, after the user panned away too", async () => {
    const t = setup();
    t.setViewport({ x: -3000, y: 0, zoom: 0.2 });
    act(() => canvasFrameRetileStore.request("a", close));
    await act(async () => { await vi.advanceTimersByTimeAsync(TIDY_DEBOUNCE_MS + 50); });
    expect(t.arrangeFrameMembers).toHaveBeenCalledTimes(1);
    expect(t.arrangeFrameMembers).toHaveBeenCalledWith("a", expect.anything());
    // The camera lands on Frame a's members (BOUNDS fit to the screen), never on the whole canvas.
    expect(t.flow.setViewport).toHaveBeenCalledTimes(1);
    expect(t.flow.setViewport.mock.calls[0][0].zoom).toBeGreaterThan(0.2);
  });

  it("closing a member of a Frame that is not active re-tiles in its box, camera untouched", async () => {
    const t = setup();
    act(() => canvasFrameRetileStore.request("b", close));
    await act(async () => { await vi.advanceTimersByTimeAsync(TIDY_DEBOUNCE_MS + 50); });
    expect(t.retileFrameMembers).toHaveBeenCalledWith("b");
    expect(t.flow.setViewport).not.toHaveBeenCalled();
  });

  it("a burst across Frames moves the camera once, onto the active Frame", async () => {
    const t = setup();
    act(() => {
      canvasFrameRetileStore.request("b", open);
      canvasFrameRetileStore.request("a", open);
      canvasFrameRetileStore.request("a", close);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(TIDY_DEBOUNCE_MS + 50); });
    expect(t.flow.setViewport).toHaveBeenCalledTimes(1);
    expect(t.arrangeFrameMembers).toHaveBeenCalledWith("a", expect.anything());
    expect(t.retileFrameMembers).toHaveBeenCalledWith("b");
    expect(canvasActiveFrameStore.get("c1")).toBe("a");
  });

  it("with the tidy settings off, nothing moves the camera (decision 39)", async () => {
    setCanvasBehaviorSetting("tidyMode", "off");
    const t = setup();
    act(() => canvasFrameRetileStore.request("a", open));
    await act(async () => { await vi.advanceTimersByTimeAsync(TIDY_DEBOUNCE_MS + 50); });
    act(() => canvasFrameRetileStore.request("a", close));
    await act(async () => { await vi.advanceTimersByTimeAsync(TIDY_DEBOUNCE_MS + 50); });
    expect(t.retileFrameMembers).toHaveBeenCalledTimes(2);
    expect(t.flow.setViewport).not.toHaveBeenCalled();
  });
});

describe("active Frame upkeep (decision 36)", () => {
  it("restores a valid stored Frame and falls back to the first Frame when it is gone", () => {
    canvasActiveFrameStore.set("c1", "b");
    setup();
    expect(canvasActiveFrameStore.get("c1")).toBe("b");
    canvasActiveFrameStore.reset();
    canvasActiveFrameStore.set("c1", "stale");
    setup();
    expect(canvasActiveFrameStore.get("c1")).toBe("a");
  });
  it("deleting the active Frame activates the nearest remaining one", () => {
    const t = setup([frame("a"), frame("b", 2000), frame("c", 2600)]);
    act(() => t.hook.result.current.activateFrame("b"));
    expect(canvasActiveFrameStore.get("c1")).toBe("b");
    t.hook.rerender({ nodes: [frame("a"), frame("c", 2600)], boardReady: true, canvasKey: "c1" });
    expect(canvasActiveFrameStore.get("c1")).toBe("c");
  });
  it("never rewrites the saved value while the board is still loading", () => {
    canvasActiveFrameStore.set("c1", "b");
    const t = setup([]);
    t.hook.rerender({ nodes: [], boardReady: false, canvasKey: "c1" });
    expect(canvasActiveFrameStore.get("c1")).toBe("b");
  });
  it("activateFrame ignores an unknown Frame", () => {
    const t = setup();
    act(() => t.hook.result.current.activateFrame("nope"));
    expect(canvasActiveFrameStore.get("c1")).toBe("a");
  });
  it("selecting a single member (or a Frame) makes its Frame active; a multi-selection does not", () => {
    const t = setup();
    const sel = (id: string) => (n: Node): Node => ({ ...n, selected: n.id === id });
    const base = [frame("a"), frame("b", 2000), win("m1", "a"), win("m3", "b")];
    t.hook.rerender({ nodes: base.map(sel("m3")), boardReady: true, canvasKey: "c1" });
    expect(canvasActiveFrameStore.get("c1")).toBe("b");
    t.hook.rerender({ nodes: base.map(sel("a")), boardReady: true, canvasKey: "c1" });
    expect(canvasActiveFrameStore.get("c1")).toBe("a");
    t.hook.rerender({ nodes: base.map((n) => ({ ...n, selected: n.id === "m3" || n.id === "m1" })), boardReady: true, canvasKey: "c1" });
    expect(canvasActiveFrameStore.get("c1")).toBe("a");
  });
  it("noteNodeInteraction activates a member's Frame, or the Frame node itself", () => {
    const t = setup();
    act(() => t.hook.result.current.noteNodeInteraction(win("m3", "b")));
    expect(canvasActiveFrameStore.get("c1")).toBe("b");
    act(() => t.hook.result.current.noteNodeInteraction(frame("a")));
    expect(canvasActiveFrameStore.get("c1")).toBe("a");
    act(() => t.hook.result.current.noteNodeInteraction({ id: "loose", type: "terminal", position: { x: 0, y: 0 }, data: {} }));
    expect(canvasActiveFrameStore.get("c1")).toBe("a");
  });
});
