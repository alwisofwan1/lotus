import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CanvasZoomControlView, formatCanvasZoomPercentage, nextCanvasZoom } from "../CanvasZoomControl";

describe("CanvasZoomControl", () => {
  const bounds = { minZoom: 0.04, maxZoom: 1.25 };

  it("formats the current viewport zoom as a percentage", () => {
    expect(formatCanvasZoomPercentage(0.04)).toBe("4%");
    expect(formatCanvasZoomPercentage(0.055)).toBe("6%");
  });

  it("renders the current zoom percentage", () => {
    render(
      <CanvasZoomControlView
        zoom={0.043}
        bounds={bounds}
        onFitAll={vi.fn()}
        onZoomIn={vi.fn()}
        onZoomOut={vi.fn()}
      />,
    );

    expect(screen.getByText("4%")).toBeInTheDocument();
    expect(screen.getByLabelText("Canvas zoom 4%")).toBeInTheDocument();
  });

  it("calls the requested viewport actions", () => {
    const onFitAll = vi.fn();
    const onZoomIn = vi.fn();
    const onZoomOut = vi.fn();
    render(
      <CanvasZoomControlView
        zoom={0.5}
        bounds={bounds}
        onFitAll={onFitAll}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Fit all canvas nodes" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out canvas" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in canvas" }));

    expect(onFitAll).toHaveBeenCalledOnce();
    expect(onZoomOut).toHaveBeenCalledOnce();
    expect(onZoomIn).toHaveBeenCalledOnce();
  });

  it("disables zoom controls at the configured bounds", () => {
    const { rerender } = render(
      <CanvasZoomControlView
        zoom={0.04}
        bounds={bounds}
        onFitAll={vi.fn()}
        onZoomIn={vi.fn()}
        onZoomOut={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Zoom out canvas" })).toBeDisabled();

    rerender(
      <CanvasZoomControlView
        zoom={1.25}
        bounds={bounds}
        onFitAll={vi.fn()}
        onZoomIn={vi.fn()}
        onZoomOut={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Zoom in canvas" })).toBeDisabled();
  });

  it("clamps step zoom calculations to the configured bounds", () => {
    expect(nextCanvasZoom(0.04, "out", bounds)).toBe(0.04);
    expect(nextCanvasZoom(1.25, "in", bounds)).toBe(1.25);
    expect(nextCanvasZoom(0.5, "in", bounds)).toBe(0.6);
    expect(nextCanvasZoom(0.6, "out", bounds)).toBe(0.5);
  });
});
