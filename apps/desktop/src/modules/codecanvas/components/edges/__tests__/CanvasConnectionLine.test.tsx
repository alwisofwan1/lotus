import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Position } from "@xyflow/react";
import { CanvasConnectionLine } from "../CanvasConnectionLine";

const baseProps = {
  fromX: 0,
  fromY: 0,
  toX: 120,
  toY: 80,
  fromPosition: Position.Right,
  toPosition: Position.Left,
  fromNode: {} as Parameters<typeof CanvasConnectionLine>[0]["fromNode"],
  fromHandle: {} as Parameters<typeof CanvasConnectionLine>[0]["fromHandle"],
  toNode: null,
  toHandle: null,
  connectionStatus: null,
  pointer: { x: 120, y: 80 },
  connectionLineType: "default",
} as Parameters<typeof CanvasConnectionLine>[0];

describe("CanvasConnectionLine", () => {
  it("guides the user toward a target while connecting", () => {
    const { container } = render(<svg><CanvasConnectionLine {...baseProps} /></svg>);

    expect(screen.getByText("Choose a target")).toBeInTheDocument();
    expect(container.querySelector(".canvas-connection-line")).toHaveAttribute("data-status", "idle");
  });

  it("shows an invalid state when React Flow rejects the hovered target", () => {
    const { container } = render(<svg><CanvasConnectionLine {...baseProps} connectionStatus="invalid" /></svg>);

    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(container.querySelector(".canvas-connection-line")).toHaveAttribute("data-status", "invalid");
  });

  it("previews hovered connections from node boundaries, not fixed handle coordinates", () => {
    const { container } = render(
      <svg>
        <CanvasConnectionLine
          {...baseProps}
          fromX={0}
          fromY={0}
          toX={999}
          toY={999}
          fromNode={{ internals: { positionAbsolute: { x: 0, y: 0 } }, measured: { width: 100, height: 80 } } as typeof baseProps.fromNode}
          toNode={{ internals: { positionAbsolute: { x: 240, y: 10 } }, measured: { width: 120, height: 80 } } as typeof baseProps.toNode}
          connectionStatus="valid"
        />
      </svg>,
    );

    const path = container.querySelector(".canvas-connection-line-path")?.getAttribute("d") ?? "";
    expect(path).toMatch(/^M\s?110[, ]/);
    expect(path).toContain("230");
    expect(screen.getByText("Release to connect")).toBeInTheDocument();
  });
});
