import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentNodeActionBar } from "../AgentNodeActionBar";

describe("AgentNodeActionBar", () => {
  it("always renders Kill and fires onClose", () => {
    const onClose = vi.fn();
    render(<AgentNodeActionBar onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Kill agent" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders the WT button only when a worktree handler is provided", () => {
    const { rerender } = render(<AgentNodeActionBar onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Worktree" })).toBeNull();
    const onToggleWT = vi.fn();
    rerender(<AgentNodeActionBar onClose={() => {}} onToggleWT={onToggleWT} />);
    fireEvent.click(screen.getByRole("button", { name: "Worktree" }));
    expect(onToggleWT).toHaveBeenCalledOnce();
  });

  it("marks the WT button pressed while its panel is open", () => {
    render(<AgentNodeActionBar onClose={() => {}} onToggleWT={() => {}} wtActive />);
    expect(screen.getByRole("button", { name: "Worktree" })).toHaveAttribute("aria-pressed", "true");
  });

  it("renders the IDE button only when an editor handler is provided and fires it", () => {
    const { rerender } = render(<AgentNodeActionBar onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Open in IDE" })).toBeNull();
    const onOpenIde = vi.fn();
    rerender(<AgentNodeActionBar onClose={() => {}} onOpenIde={onOpenIde} />);
    fireEvent.click(screen.getByRole("button", { name: "Open in IDE" }));
    expect(onOpenIde).toHaveBeenCalledOnce();
  });

  it("renders the Skills button only when wired and reflects an active skills node", () => {
    const onToggleSkills = vi.fn();
    const { rerender } = render(<AgentNodeActionBar onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Skills" })).toBeNull();
    rerender(<AgentNodeActionBar onClose={() => {}} onToggleSkills={onToggleSkills} skillsActive />);
    const btn = screen.getByRole("button", { name: "Skills" });
    expect(btn).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(btn);
    expect(onToggleSkills).toHaveBeenCalledOnce();
  });

  it("renders Promote to Terminal only when wired and fires it", () => {
    const onPromoteToTerminal = vi.fn();
    const { rerender } = render(<AgentNodeActionBar onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Promote to Terminal" })).toBeNull();
    rerender(<AgentNodeActionBar onClose={() => {}} onPromoteToTerminal={onPromoteToTerminal} />);
    fireEvent.click(screen.getByRole("button", { name: "Promote to Terminal" }));
    expect(onPromoteToTerminal).toHaveBeenCalledOnce();
  });

  it("disables Promote to Terminal while the agent is busy", () => {
    render(<AgentNodeActionBar onClose={() => {}} onPromoteToTerminal={() => {}} promoteToTerminalDisabled />);
    expect(screen.getByRole("button", { name: "Promote to Terminal" })).toBeDisabled();
  });

  it("stops pointer propagation so dragging a button never pans the canvas", () => {
    const onToggleWT = vi.fn();
    render(<AgentNodeActionBar onClose={() => {}} onToggleWT={onToggleWT} />);
    const btn = screen.getByRole("button", { name: "Worktree" });
    const evt = new MouseEvent("pointerdown", { bubbles: true });
    const stop = vi.spyOn(evt, "stopPropagation");
    btn.dispatchEvent(evt);
    expect(stop).toHaveBeenCalled();
  });
});
