import { afterEach, describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import { FrameNode } from "../FrameNode";
import { canvasFrameOverviewStore } from "../../../services/canvas-frame-overview-store";

function renderFrameNode(width = 1200) {
  const props = { id: "F", data: { title: "Frame 1", colorId: "moss" }, selected: false, width } as unknown as NodeProps;
  return render(
    <ReactFlowProvider>
      <FrameNode {...props} />
    </ReactFlowProvider>,
  );
}

afterEach(() => act(() => canvasFrameOverviewStore.close()));

describe("FrameNode tab count", () => {
  it("shows the title tab with the member count outside the Overview, and no card", () => {
    const { container } = renderFrameNode();
    expect(container.querySelector(".canvas-frame-tab-count")).not.toBeNull();
    expect(container.querySelector(".canvas-frame-overview-card")).toBeNull();
    expect(container.querySelector(".canvas-frame-node")?.getAttribute("data-overview")).toBeNull();
  });
});

describe("FrameNode Overview header card (decisions 42, 44)", () => {
  it("replaces the tab with ONE clean card: colour dot, name, and the live label", () => {
    const { container } = renderFrameNode();
    act(() => canvasFrameOverviewStore.open({ F: { text: "01 · 5 nodes", needsYou: false } }, null));
    expect(container.querySelector(".canvas-frame-tab")).toBeNull();
    const card = container.querySelector(".canvas-frame-overview-card")!;
    expect(card.querySelector(".canvas-frame-overview-card-dot")).not.toBeNull();
    expect(card.querySelector(".canvas-frame-overview-card-title")?.textContent).toBe("Frame 1");
    expect(card.querySelector(".canvas-frame-overview-card-label")?.textContent).toBe("01 · 5 nodes");
  });

  it("says needs you in the label and flags the Frame", () => {
    const { container } = renderFrameNode();
    act(() => canvasFrameOverviewStore.open({ F: { text: "02 · needs you", needsYou: true } }, null));
    expect(container.querySelector(".canvas-frame-overview-card-label")?.textContent).toBe("02 · needs you");
    expect(container.querySelector(".canvas-frame-node")?.getAttribute("data-needs-you")).toBe("true");
  });

  it("caps the card to the Frame's own width so it cannot reach a neighbour", () => {
    const { container } = renderFrameNode(900);
    act(() => canvasFrameOverviewStore.open({}, null));
    const card = container.querySelector<HTMLElement>(".canvas-frame-overview-card")!;
    expect(parseFloat(card.style.maxWidth)).toBeGreaterThan(0);
    expect(parseFloat(card.style.maxWidth)).toBeLessThanOrEqual(900);
  });

  it("lights the hovered Frame with the accent ring and shows Enter", () => {
    const { container } = renderFrameNode();
    act(() => canvasFrameOverviewStore.open({}, "F"));
    expect(container.querySelector(".canvas-frame-node")?.getAttribute("data-overview")).toBe("focus");
    expect(container.querySelector("[data-testid=frame-overview-enter]")).not.toBeNull();
    // Focus no longer reuses the drop-target look.
    expect(container.querySelector(".canvas-frame-node")?.getAttribute("data-drop-target")).toBeNull();
  });

  it("shows a calm Empty Frame state when the Frame has no members", () => {
    const { container } = renderFrameNode();
    act(() => canvasFrameOverviewStore.open({}, null));
    expect(container.querySelector("[data-testid=frame-overview-empty]")?.textContent).toBe("Empty Frame");
    expect(container.querySelector(".canvas-frame-node")?.getAttribute("data-empty")).toBe("true");
  });
});
