import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const xyflowMock = vi.hoisted(() => ({
  internalNodes: new Map<string, unknown>(),
  getBezierPath: vi.fn(() => ["M0 0 C0 0 1 1 1 1", 10, 20] as const),
}));

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    BaseEdge: ({ id, label }: { id: string; label?: string }) => <path data-testid={`edge-path-${id}`} data-label={label ?? ""} />,
    EdgeToolbar: ({ children, isVisible }: { children: ReactNode; isVisible?: boolean }) => (
      isVisible ? <div data-testid="edge-toolbar">{children}</div> : null
    ),
    getBezierPath: xyflowMock.getBezierPath,
    useInternalNode: (id: string) => xyflowMock.internalNodes.get(id),
  };
});

import { CanvasWireEdge } from "../CanvasWireEdge";

const baseProps = {
  id: "edge-1",
  source: "a",
  target: "b",
  sourceX: 0,
  sourceY: 0,
  targetX: 100,
  targetY: 100,
  sourcePosition: "right",
  targetPosition: "left",
  selected: true,
  animated: false,
  selectable: true,
  deletable: true,
} as Parameters<typeof CanvasWireEdge>[0];

describe("CanvasWireEdge", () => {
  beforeEach(() => {
    xyflowMock.internalNodes.clear();
    xyflowMock.getBezierPath.mockClear();
  });

  it("shows a minimal delete action only when selected", () => {
    const { rerender } = render(<CanvasWireEdge {...baseProps} selected={false} />);
    expect(screen.queryByTestId("edge-toolbar")).not.toBeInTheDocument();

    rerender(<CanvasWireEdge {...baseProps} selected />);
    expect(screen.getByTestId("edge-toolbar")).toBeInTheDocument();
  });

  it("calls delete from the selected edge action", () => {
    const onDelete = vi.fn();

    render(<CanvasWireEdge {...baseProps} data={{ onDelete }} />);

    expect(screen.getByTestId("edge-path-edge-1")).toHaveAttribute("data-label", "");
    expect(screen.queryByLabelText("Wire type")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Source port")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Target port")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete wire" }));
    expect(onDelete).toHaveBeenCalledWith("edge-1");
  });

  it("renders agent workflow labels through the edge path", () => {
    render(<CanvasWireEdge {...baseProps} label="context" data={{ wireKind: "context" }} />);
    expect(screen.getByTestId("edge-path-edge-1")).toHaveAttribute("data-label", "context");
  });

  it("renders from dynamic node boundaries instead of fixed handle coordinates", () => {
    xyflowMock.internalNodes.set("a", {
      internals: { positionAbsolute: { x: 0, y: 0 } },
      measured: { width: 100, height: 80 },
    });
    xyflowMock.internalNodes.set("b", {
      internals: { positionAbsolute: { x: 240, y: 10 } },
      measured: { width: 120, height: 80 },
    });

    render(<CanvasWireEdge {...baseProps} sourceX={5} sourceY={5} targetX={6} targetY={6} />);

    expect(xyflowMock.getBezierPath).toHaveBeenLastCalledWith(expect.objectContaining({
      sourceX: 110,
      targetX: 230,
      sourcePosition: "right",
      targetPosition: "left",
    }));
  });
});
