import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CanvasFrameSwitcher } from "../CanvasFrameSwitcher";
import type { FrameChip } from "../../services/canvas-frame-switcher";

const chip = (n: number, extra: Partial<FrameChip> = {}): FrameChip => ({
  frameId: `f${n}`,
  index: n,
  label: String(n),
  name: `Frame ${n}`,
  status: "idle",
  tone: "idle",
  needsYou: false,
  ...extra,
});

describe("CanvasFrameSwitcher compact (docked command bar)", () => {
  it("shows one trigger for the active Frame, and the menu lists every Frame plus New Frame", () => {
    const onGoToFrame = vi.fn();
    const onCreateFrame = vi.fn();
    render(
      <CanvasFrameSwitcher
        compact
        chips={[chip(1), chip(2)]}
        overflow={[chip(3)]}
        activeFrameId="f2"
        onGoToFrame={onGoToFrame}
        onCreateFrame={onCreateFrame}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Frames, Frame 2 active" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "1Frame 1",
      "2Frame 2",
      "3Frame 3",
      "New Frame",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: /Frame 3/ }));
    expect(onGoToFrame).toHaveBeenCalledWith("f3");
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "New Frame" }));
    expect(onCreateFrame).toHaveBeenCalledOnce();
  });

  it("says on the trigger when any Frame needs you, folded or not", () => {
    render(
      <CanvasFrameSwitcher
        compact
        chips={[chip(1)]}
        overflow={[chip(2, { needsYou: true, tone: "blocked" })]}
        activeFrameId="f1"
        onGoToFrame={vi.fn()}
        onCreateFrame={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Frames, Frame 1 active · needs you" });
    expect(trigger).toHaveAttribute("data-needs-you", "true");
  });

  it("is just the New Frame button while there are no Frames", () => {
    render(<CanvasFrameSwitcher compact chips={[]} overflow={[]} onGoToFrame={vi.fn()} onCreateFrame={vi.fn()} />);
    expect(screen.getByRole("button", { name: "New Frame" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Frames/ })).toBeNull();
  });
});
