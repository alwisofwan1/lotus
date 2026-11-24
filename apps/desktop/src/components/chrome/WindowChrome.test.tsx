import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WindowChrome } from "./WindowChrome";

describe("WindowChrome", () => {
  it("routes double click through drag regions only when configured", () => {
    const handleDoubleClick = vi.fn();
    const { container, getByText } = render(
      <WindowChrome
        className="chrome"
        dragRegionEnabled
        dragRegionCapturesDoubleClick
        onDoubleClick={handleDoubleClick}
        leftContent={<div>Settings</div>}
        centerDragRegionClassName="flex-1"
      />,
    );

    const root = container.firstElementChild as HTMLElement;
    const dragRegion = container.querySelector("[data-tauri-drag-region='true']") as HTMLElement;

    fireEvent.doubleClick(root);
    expect(handleDoubleClick).not.toHaveBeenCalled();

    fireEvent.doubleClick(getByText("Settings"));
    expect(handleDoubleClick).not.toHaveBeenCalled();

    fireEvent.doubleClick(dragRegion);
    expect(handleDoubleClick).toHaveBeenCalledTimes(1);
  });

  it("keeps legacy root double click behavior by default", () => {
    const handleDoubleClick = vi.fn();
    const { container } = render(
      <WindowChrome
        className="chrome"
        dragRegionEnabled
        onDoubleClick={handleDoubleClick}
        leftContent={<div>Settings</div>}
      />,
    );

    fireEvent.doubleClick(container.firstElementChild as HTMLElement);
    expect(handleDoubleClick).toHaveBeenCalledTimes(1);
  });
});
