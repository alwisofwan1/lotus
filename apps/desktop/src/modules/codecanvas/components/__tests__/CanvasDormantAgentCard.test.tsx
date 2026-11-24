import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanvasDormantAgentCard } from "../sessions/CanvasDormantAgentCard";

describe("CanvasDormantAgentCard", () => {
  // The card exists so an eight-agent board opens instantly instead of spawning eight CLIs. If it
  // reads as "an agent that is quiet" the deferral looks like a bug, so this is stated outright.
  it("says plainly that nothing is running", () => {
    render(<CanvasDormantAgentCard onResume={vi.fn()} />);
    expect(screen.getByText(/not running/i)).toBeInTheDocument();
  });

  it("names the conversation it is holding", () => {
    render(<CanvasDormantAgentCard title="Transcript route" onResume={vi.fn()} />);
    expect(screen.getByText("Transcript route")).toBeInTheDocument();
  });

  it("shows the last thing the agent said", () => {
    render(
      <CanvasDormantAgentCard preview="Saya sudah pindahkan parser ke tui-source.ts" onResume={vi.fn()} />,
    );
    expect(screen.getByText(/parser ke tui-source/)).toBeInTheDocument();
  });

  it("falls back to a plain statement when there is no preview to show", () => {
    render(<CanvasDormantAgentCard onResume={vi.fn()} />);
    expect(screen.getByText(/previous conversation is saved/i)).toBeInTheDocument();
  });

  it("distinguishes a preview still being read from one that is empty", () => {
    render(<CanvasDormantAgentCard loadingPreview onResume={vi.fn()} />);
    expect(screen.getByText(/reading the last conversation/i)).toBeInTheDocument();
  });

  it("wakes the node only when asked", () => {
    const onResume = vi.fn();
    render(<CanvasDormantAgentCard onResume={onResume} />);
    expect(onResume).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /resume/i }));
    expect(onResume).toHaveBeenCalledOnce();
  });
});
