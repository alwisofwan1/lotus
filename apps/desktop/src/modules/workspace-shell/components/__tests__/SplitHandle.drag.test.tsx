import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SplitHandle } from "@/modules/workspace-shell/components/SplitHandle";

describe("SplitHandle — what a drag reports", () => {
  it("reports the size the pointer asks for, measured from where the drag began", () => {
    const onResize = vi.fn();
    render(
      <SplitHandle
        orientation="vertical"
        size={580}
        min={180}
        max={989}
        defaultSize={584}
        label="Resize pane"
        onResize={onResize}
      />,
    );

    const handle = screen.getByRole("separator", { name: "Resize pane" });
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);
    handle.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 600, clientY: 300 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 450, clientY: 300 });

    // Pulled 150px left from a 580px track: the answer is 430, once.
    expect(onResize).toHaveBeenLastCalledWith(430);
  });

  it("grows the pane AFTER the seam when the pointer moves toward it — a right-hand panel", () => {
    const onResize = vi.fn();
    render(
      <SplitHandle
        orientation="vertical"
        sizes="after"
        size={260}
        min={210}
        max={600}
        defaultSize={260}
        label="Resize nav"
        onResize={onResize}
      />,
    );

    const handle = screen.getByRole("separator", { name: "Resize nav" });
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);
    handle.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 1000, clientY: 300 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900, clientY: 300 });

    // Pulled 100px LEFT, into the list: the nav on the right gets wider.
    expect(onResize).toHaveBeenLastCalledWith(360);
  });

  it("maps the arrow keys the same way: ArrowLeft widens a pane that sits after the seam", () => {
    const onResize = vi.fn();
    render(
      <SplitHandle
        orientation="vertical"
        sizes="after"
        size={260}
        min={210}
        max={600}
        defaultSize={260}
        label="Resize nav"
        onResize={onResize}
      />,
    );

    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize nav" }), { key: "ArrowLeft" });
    expect(onResize).toHaveBeenLastCalledWith(276);
  });
});
