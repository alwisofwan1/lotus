import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import { CanvasJumpLabels } from "../CanvasJumpLabels";
import { createJumpLabelsStore } from "../../services/jump-labels-store";

vi.mock("@xyflow/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xyflow/react")>()),
  ViewportPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const node = (id: string, x: number, y: number): Node =>
  ({ id, type: "agent", position: { x, y }, data: {} }) as unknown as Node;

const NODES = [node("a1", 100, 200), node("a2", 500, 200), node("a3", 900, 200)];

function labels(nodes = NODES) {
  const store = createJumpLabelsStore();
  return { store, ...render(<CanvasJumpLabels nodes={nodes} store={store} />) };
}

describe("CanvasJumpLabels", () => {
  it("draws nothing while the badges are closed", () => {
    labels();

    expect(screen.queryByTestId("jump-label-a1")).not.toBeInTheDocument();
  });

  it("puts a badge on each cell, at that cell's own position", () => {
    const { store } = labels();

    act(() => store.open(["a1", "a2", "a3"]));

    expect(screen.getByTestId("jump-label-a1")).toHaveTextContent("a");
    expect(screen.getByTestId("jump-label-a2")).toHaveStyle({ left: "500px", top: "200px" });
  });

  it("hides the badges that no longer match, which is how a first letter gives feedback", () => {
    // With two-letter labels there is otherwise no sign that anything registered.
    const many = Array.from({ length: 20 }, (_, i) => node(`n${i}`, i * 10, 0));
    const { store } = labels(many);
    act(() => store.open(many.map((n) => n.id)));

    act(() => void store.typeKey("a"));

    expect(screen.getByTestId("jump-label-n0")).toBeInTheDocument();
    // `n9` is labelled "sa" — a different first letter, so it drops out.
    expect(screen.queryByTestId("jump-label-n9")).not.toBeInTheDocument();
  });

  it("keeps the typed part visible but receded, so progress is readable", () => {
    const many = Array.from({ length: 20 }, (_, i) => node(`n${i}`, i * 10, 0));
    const { store } = labels(many);
    act(() => store.open(many.map((n) => n.id)));

    act(() => void store.typeKey("a"));

    const badge = screen.getByTestId("jump-label-n0");
    expect(badge.querySelector(".canvas-jump-label-done")).toHaveTextContent("a");
    expect(badge).toHaveTextContent("aa");
  });

  it("skips a label whose cell has gone", () => {
    // A node can close between opening the badges and the next repaint.
    const { store } = labels([node("a1", 0, 0)]);

    act(() => store.open(["a1", "gone"]));

    expect(screen.getByTestId("jump-label-a1")).toBeInTheDocument();
    expect(screen.queryByTestId("jump-label-gone")).not.toBeInTheDocument();
  });

  it("clears when cancelled", () => {
    const { store } = labels();
    act(() => store.open(["a1"]));

    act(() => store.cancel());

    expect(screen.queryByTestId("jump-label-a1")).not.toBeInTheDocument();
  });
});
