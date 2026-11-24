import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SplitHandle } from "../SplitHandle";

function renderHandle(overrides: Partial<React.ComponentProps<typeof SplitHandle>> = {}) {
  const props = {
    orientation: "vertical" as const,
    size: 300,
    min: 232,
    max: 420,
    defaultSize: 300,
    label: "Resize workspace rail",
    onResize: vi.fn(),
    ...overrides,
  };
  render(<SplitHandle {...props} />);
  return props;
}

describe("SplitHandle", () => {
  it("is a separator with a reported position, so it is reachable without a pointer", () => {
    renderHandle();
    const handle = screen.getByRole("separator", { name: "Resize workspace rail" });
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuenow")).toBe("300");
    expect(handle.getAttribute("aria-valuemin")).toBe("232");
    expect(handle.getAttribute("aria-valuemax")).toBe("420");
    expect(handle.getAttribute("tabindex")).toBe("0");
  });

  it("resizes with the arrow keys along its own axis", () => {
    const props = renderHandle();
    const handle = screen.getByRole("separator");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(props.onResize).toHaveBeenCalledWith(316);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(props.onResize).toHaveBeenLastCalledWith(284);
  });

  it("takes a larger step with Shift and stops at the limit", () => {
    const props = renderHandle({ size: 400 });
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight", shiftKey: true });
    expect(props.onResize).toHaveBeenCalledWith(420);
  });

  it("ignores the cross-axis arrows", () => {
    const props = renderHandle();
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowUp" });
    expect(props.onResize).not.toHaveBeenCalled();
  });

  it("puts the seam back on double-click and on Home", () => {
    const props = renderHandle({ size: 400 });
    fireEvent.doubleClick(screen.getByRole("separator"));
    expect(props.onResize).toHaveBeenCalledWith(300);

    fireEvent.keyDown(screen.getByRole("separator"), { key: "Home" });
    expect(props.onResize).toHaveBeenLastCalledWith(300);
  });

  it("uses the vertical arrows when it is a horizontal seam", () => {
    const props = renderHandle({ orientation: "horizontal", size: 300 });
    const handle = screen.getByRole("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(props.onResize).toHaveBeenCalledWith(316);
  });
});
