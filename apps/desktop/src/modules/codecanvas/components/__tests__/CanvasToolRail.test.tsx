import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanvasToolRail } from "../CanvasToolRail";

describe("CanvasToolRail", () => {
  it("marks the active tool with aria-pressed", () => {
    render(<CanvasToolRail activeTool="select" onSelectTool={() => {}} />);
    expect(screen.getByRole("button", { name: /select/i }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /rectangle/i }).getAttribute("aria-pressed")).toBe("false");
  });

  it("reports tool selection on click", () => {
    const onSelectTool = vi.fn();
    render(<CanvasToolRail activeTool="select" onSelectTool={onSelectTool} />);
    fireEvent.click(screen.getByRole("button", { name: /rectangle/i }));
    expect(onSelectTool).toHaveBeenCalledWith("rectangle");
  });

  it("renders the core Excalidraw tools", () => {
    render(<CanvasToolRail activeTool="select" onSelectTool={() => {}} />);
    for (const name of [/select/i, /pan/i, /rectangle/i, /diamond/i, /ellipse/i, /text/i]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });
});
