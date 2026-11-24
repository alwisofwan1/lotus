import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: ({ type, id, position, className, "aria-label": ariaLabel }: { type: string; id?: string; position?: string; className?: string; "aria-label"?: string }) => (
      <div
        data-testid={id ? `handle-${id}` : `handle-${type}`}
        data-type={type}
        data-position={position}
        className={className}
        aria-label={ariaLabel}
      />
    ),
    NodeResizer: ({ minWidth, minHeight, isVisible, handleClassName, lineClassName }: { minWidth: number; minHeight: number; isVisible?: boolean; handleClassName?: string; lineClassName?: string }) => (
      <div
        data-testid="node-resizer"
        data-min-width={minWidth}
        data-min-height={minHeight}
        data-visible={String(!!isVisible)}
        data-handle-class={handleClassName}
        data-line-class={lineClassName}
      />
    ),
  };
});

import { CanvasNodeFrame } from "../nodes/CanvasNodeFrame";

function renderFrame(props?: Partial<Parameters<typeof CanvasNodeFrame>[0]>) {
  return render(
    <CanvasNodeFrame
      kind="terminal"
      selected={false}
      minWidth={300}
      minHeight={200}
      header={<div data-testid="header-slot">HEADER</div>}
      {...props}
    >
      <div data-testid="body-slot">BODY</div>
    </CanvasNodeFrame>,
  );
}

describe("CanvasNodeFrame", () => {
  it("renders the header slot", () => {
    renderFrame();
    expect(screen.getByTestId("header-slot")).toBeInTheDocument();
  });

  it("renders the body (children) slot", () => {
    renderFrame();
    expect(screen.getByTestId("body-slot")).toBeInTheDocument();
  });

  it("renders the overlay slot when provided", () => {
    renderFrame({ overlay: <div data-testid="overlay-slot">PANEL</div> });
    expect(screen.getByTestId("overlay-slot")).toBeInTheDocument();
  });

  it("omits the overlay slot when not provided", () => {
    renderFrame();
    expect(screen.queryByTestId("overlay-slot")).not.toBeInTheDocument();
  });

  it("applies the base and kind classes", () => {
    const { container } = renderFrame({ kind: "note" });
    const root = container.querySelector(".canvas-node");
    expect(root).toHaveClass("canvas-node", "canvas-note-node");
  });

  it("adds the selected class only when selected", () => {
    const { container, rerender } = renderFrame({ selected: false });
    expect(container.querySelector(".canvas-node")).not.toHaveClass("selected");
    rerender(
      <CanvasNodeFrame kind="terminal" selected minWidth={300} minHeight={200} header={<div />}>
        <div />
      </CanvasNodeFrame>,
    );
    expect(container.querySelector(".canvas-node")).toHaveClass("selected");
  });

  it("renders an always-available full-detail resizer with larger custom affordance classes", () => {
    renderFrame({ selected: false, minWidth: 250, minHeight: 175 });
    const resizer = screen.getByTestId("node-resizer");
    expect(resizer).toHaveAttribute("data-min-width", "250");
    expect(resizer).toHaveAttribute("data-min-height", "175");
    expect(resizer).toHaveAttribute("data-visible", "true");
    expect(resizer).toHaveAttribute("data-handle-class", "canvas-node-resize-handle");
    expect(resizer).toHaveAttribute("data-line-class", "canvas-node-resize-line");
  });

  it("renders one clean connection handle on every side", () => {
    renderFrame();

    for (const side of ["top", "right", "bottom", "left"]) {
      expect(screen.getByTestId(`handle-wire-${side}`)).toHaveAttribute("data-type", "source");
      expect(screen.getByTestId(`handle-wire-${side}`)).toHaveClass("canvas-node-handle", "canvas-node-handle--wire", `canvas-node-handle--${side}`);
    }
  });

  it("labels each handle by its side", () => {
    renderFrame();

    expect(screen.getByLabelText("Wire from top side")).toBeInTheDocument();
    expect(screen.getByLabelText("Wire from left side")).toBeInTheDocument();
  });

  it("renders the full body and tags data-lod=full by default", () => {
    const { container } = renderFrame({ glyph: <div data-testid="glyph-slot">GLYPH</div> });
    expect(container.querySelector(".canvas-node")).toHaveAttribute("data-lod", "full");
    expect(screen.getByTestId("body-slot")).toBeInTheDocument();
    expect(screen.queryByTestId("glyph-slot")).not.toBeInTheDocument();
  });

  it("swaps the body for the glyph at the glyph tier, keeping handles", () => {
    const { container } = renderFrame({ lodTier: "glyph", glyph: <div data-testid="glyph-slot">GLYPH</div> });
    const root = container.querySelector(".canvas-node");
    expect(root).toHaveClass("canvas-node--glyph");
    expect(root).toHaveAttribute("data-lod", "glyph");
    expect(screen.getByTestId("glyph-slot")).toBeInTheDocument();
    expect(screen.queryByTestId("body-slot")).not.toBeInTheDocument();
    expect(screen.getByTestId("handle-wire-top")).toBeInTheDocument();
    expect(screen.getByTestId("node-resizer")).toHaveAttribute("data-visible", "false");
  });

  it("swaps the body for the glyph at the overview tier and marks overview separately", () => {
    const { container } = renderFrame({ lodTier: "overview", glyph: <div data-testid="glyph-slot">GLYPH</div> });
    const root = container.querySelector(".canvas-node");
    expect(root).toHaveClass("canvas-node--glyph", "canvas-node--overview");
    expect(root).toHaveAttribute("data-lod", "overview");
    expect(screen.getByTestId("glyph-slot")).toBeInTheDocument();
    expect(screen.queryByTestId("body-slot")).not.toBeInTheDocument();
    expect(screen.getByTestId("node-resizer")).toHaveAttribute("data-visible", "false");
  });

  it("stays in full detail at collapsed tiers when no glyph is supplied", () => {
    const { unmount } = renderFrame({ lodTier: "glyph" });
    expect(screen.getByTestId("body-slot")).toBeInTheDocument();

    unmount();
    renderFrame({ lodTier: "overview" });
    expect(screen.getByTestId("body-slot")).toBeInTheDocument();
  });
});
