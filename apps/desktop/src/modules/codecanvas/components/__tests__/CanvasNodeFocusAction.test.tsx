import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { CanvasNodeFocusAction } from "../nodes/CanvasNodeFocusAction";

describe("CanvasNodeFocusAction", () => {
  it("renders a labelled Focus button and fires onFocus", () => {
    const onFocus = vi.fn();
    render(<CanvasNodeFocusAction onFocus={onFocus} />);
    const btn = screen.getByRole("button", { name: "Focus" });
    fireEvent.click(btn);
    expect(onFocus).toHaveBeenCalledOnce();
  });

  it("defaults to the persona action chrome but accepts a per-node className", () => {
    const { rerender } = render(<CanvasNodeFocusAction onFocus={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Focus" }).className).toContain("canvas-persona-action--focus");
    rerender(<CanvasNodeFocusAction onFocus={vi.fn()} className="cth-action cth-action--focus" />);
    expect(screen.getByRole("button", { name: "Focus" }).className).toBe("cth-action cth-action--focus");
  });

  it("stops propagation so the click never drags the node or reaches the canvas", () => {
    const onFocus = vi.fn();
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <CanvasNodeFocusAction onFocus={onFocus} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    expect(onFocus).toHaveBeenCalledOnce();
    expect(parentClick).not.toHaveBeenCalled();
  });
});
