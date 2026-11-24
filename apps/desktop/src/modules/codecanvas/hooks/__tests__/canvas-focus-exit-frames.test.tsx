import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";

vi.mock("@/modules/codespace/services/terminal-session-registry", () => ({
  closeTerminalSession: vi.fn(),
}));

import { useCanvasNodes } from "../useCanvasNodes";
import { useCanvasFocusMode } from "../useCanvasFocusMode";
import type { CanvasSnapshot } from "../../types/canvas";

// Leaving node focus inside a Frame used to fit the camera to the WHOLE pre-focus snapshot — every
// Frame box included — while entering is confined to the hero's Frame (decision 41).
// Frame Grid 2x2: Frame 1 holds three windows tiled to fill the screen; Frames 2-4 are empty.
const FRAME = { w: 1900, h: 1050 };
const term = (id: string, n: number, x: number) => ({
  type: "terminal" as const, id, position: { x, y: 0 }, size: { w: 620, h: 1050 },
  cwd: "/p", terminalNumber: n, assignedWorktree: null, frameId: "f1",
});
const frame = (id: string, x: number, y: number) => ({
  type: "frame" as const, id, position: { x, y }, size: FRAME, title: id,
});
const BOARD = {
  schemaVersion: 1, id: "default", rootDir: "/p", edges: [],
  nodes: [
    frame("f1", 0, 0), frame("f2", 2000, 0), frame("f3", 0, 1200), frame("f4", 2000, 1200),
    term("t1", 1, 0), term("t2", 2, 640), term("t3", 3, 1280),
  ],
} as unknown as CanvasSnapshot;

describe("focus exit with Frames", () => {
  it("returns the camera to the pre-focus zoom, not a fit of every Frame", async () => {
    const pane = document.createElement("div");
    pane.className = "react-flow";
    pane.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 2000, bottom: 1250, width: 2000, height: 1250, toJSON: () => ({}) });
    document.body.appendChild(pane);
    // Pre-focus: the user was looking at Frame 1 filling the screen, zoom ~1.
    let viewport = { x: 0, y: 0, zoom: 1 };
    const flow = {
      getViewport: () => viewport,
      setViewport: vi.fn(async (v: typeof viewport) => { viewport = v; return true; }),
    } as unknown as ReactFlowInstance<Node, Edge>;

    const { result } = renderHook(() => {
      const board = useCanvasNodes({ current: "/p" }, vi.fn());
      const focus = useCanvasFocusMode({
        flowInstance: flow,
        nodes: board.nodes,
        applyFocusLayout: board.applyFocusLayout,
        captureLayoutSnapshot: board.captureLayoutSnapshot,
        restoreLayoutSnapshot: board.restoreLayoutSnapshot,
      });
      return { board, focus };
    });
    act(() => result.current.board.loadSnapshot(BOARD));

    act(() => result.current.focus.enterFocus("t2"));
    act(() => result.current.focus.exitFocus());

    await Promise.resolve();
    const exitTarget = (flow.setViewport as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    // Framing every Frame of the grid put Frame 1 in the top-left quadrant at 48% (the reported bug).
    expect(exitTarget.zoom).toBeGreaterThan(0.9);
  });
});
