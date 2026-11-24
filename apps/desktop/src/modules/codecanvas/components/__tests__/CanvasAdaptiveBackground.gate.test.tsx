import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

let mockZoom = 1;
vi.mock("@xyflow/react", () => ({
  useStore: (selector: (s: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, mockZoom] }),
  Background: () => <div data-testid="rf-background" />,
}));

import { CanvasAdaptiveBackground } from "../CanvasAdaptiveBackground";

const theme = { variant: "dots", gap: 24, size: 1, color: "#fff" } as Parameters<typeof CanvasAdaptiveBackground>[0]["theme"];

describe("CanvasAdaptiveBackground (NaN-zoom guard)", () => {
  it("renders the ReactFlow background at a finite zoom", () => {
    mockZoom = 1;
    const { queryByTestId } = render(<CanvasAdaptiveBackground theme={theme} />);
    expect(queryByTestId("rf-background")).toBeInTheDocument();
  });

  it("renders nothing when the viewport zoom is non-finite (prevents cx=NaN)", () => {
    mockZoom = Number.NaN;
    const { queryByTestId } = render(<CanvasAdaptiveBackground theme={theme} />);
    expect(queryByTestId("rf-background")).not.toBeInTheDocument();
  });
});
