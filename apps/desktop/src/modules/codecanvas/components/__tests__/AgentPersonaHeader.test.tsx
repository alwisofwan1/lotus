import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { AgentPersonaHeader } from "../nodes/AgentPersonaHeader";
import { resolveRunnerVisualIdentity } from "../../services/runner-visual-identity";

const base = { name: "Skye", runner: "claude" as const, tone: "running" as const };

describe("AgentPersonaHeader (CNVS-style, ADR-0027)", () => {
  it("shows the name, names the runner on its logo, and no CLD badge / model / YOLO chips", () => {
    render(<AgentPersonaHeader {...base} onClose={vi.fn()} />);
    expect(screen.getByText("Skye")).toBeInTheDocument();
    expect(screen.getByLabelText(/Claude Code/)).toHaveAttribute("title", "Claude Code");
    expect(screen.queryByText(/Claude Code/)).not.toBeInTheDocument();
    expect(screen.queryByText("CLD")).not.toBeInTheDocument();
    expect(screen.queryByText("YOLO")).not.toBeInTheDocument();
  });

  it("labels other runners", () => {
    const { rerender } = render(<AgentPersonaHeader {...base} runner="codex" onClose={vi.fn()} />);
    expect(screen.getByLabelText(/Codex/)).toBeInTheDocument();
    rerender(<AgentPersonaHeader {...base} runner="cursor" onClose={vi.fn()} />);
    expect(screen.getByLabelText(/Cursor Agent/)).toBeInTheDocument();
  });

  it("shows a custom Claude-family runner with its registry identity", () => {
    const runnerIdentity = resolveRunnerVisualIdentity({
      runner: "custom",
      customRunner: { id: "custom-hss", name: "HSS", claudeFamily: true },
    });

    const { container } = render(
      <AgentPersonaHeader
        {...base}
        runner="custom"
        runnerIdentity={runnerIdentity}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/HSS/)).toBeInTheDocument();
    const badge = container.querySelector(".canvas-persona-badge") as HTMLElement;
    expect(badge).toHaveAttribute("data-mark", "logo");
    expect(badge.style.getPropertyValue("--badge-logo")).toBe('url("/assets/ai-logo/Claude.svg")');
  });

  it("renders the Pi glyph without an empty CSS mask", () => {
    const runnerIdentity = resolveRunnerVisualIdentity({
      runner: "custom",
      customRunner: { id: "custom-pi", name: "Pi", claudeFamily: false },
    });

    const { container } = render(
      <AgentPersonaHeader
        {...base}
        runner="custom"
        runnerIdentity={runnerIdentity}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("π")).toBeInTheDocument();
    const badge = container.querySelector(".canvas-persona-badge") as HTMLElement;
    expect(badge).toHaveAttribute("data-mark", "glyph");
    expect(badge.style.getPropertyValue("--badge-logo")).toBe("");
  });

  it("renders a terminal CLI icon for an unknown custom runner", () => {
    const runnerIdentity = resolveRunnerVisualIdentity({
      runner: "custom",
      customRunner: { id: "custom-local-agent", name: "Local Agent", claudeFamily: false },
    });

    const { container } = render(
      <AgentPersonaHeader
        {...base}
        runner="custom"
        runnerIdentity={runnerIdentity}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/Local Agent/)).toBeInTheDocument();
    const badge = container.querySelector(".canvas-persona-badge") as HTMLElement;
    expect(badge).toHaveAttribute("data-mark", "terminal");
    expect(badge.querySelector("svg")).toBeInTheDocument();
  });

  it("carries the phase tone + runner on the header and fires onClose", () => {
    const onClose = vi.fn();
    render(<AgentPersonaHeader {...base} tone="starting" onClose={onClose} />);
    const head = screen.getByTestId("agent-persona-header");
    expect(head).toHaveAttribute("data-tone", "starting");
    expect(head).toHaveAttribute("data-runner", "claude");
    fireEvent.click(screen.getByRole("button", { name: "Close agent" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("colours the badge from the persona colour when set (Slice 6)", () => {
    const { container } = render(<AgentPersonaHeader {...base} color="#e879a6" onClose={vi.fn()} />);
    const badge = container.querySelector(".canvas-persona-badge") as HTMLElement;
    expect(badge.style.getPropertyValue("--badge-color")).toBe("#e879a6");
  });

  it("shows a Focus action only when onFocusMode is provided, and fires it", () => {
    const { rerender } = render(<AgentPersonaHeader {...base} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Focus" })).not.toBeInTheDocument();

    const onFocusMode = vi.fn();
    rerender(<AgentPersonaHeader {...base} onFocusMode={onFocusMode} onAddSkills={vi.fn()} onClose={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "Focus" });
    fireEvent.click(btn);
    expect(onFocusMode).toHaveBeenCalledOnce();
    // Sits with the other quiet header actions, before Skills in DOM order.
    const buttons = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(buttons.indexOf("Focus")).toBeLessThan(buttons.indexOf("Skills"));
  });

  it("shows a Skills action only when onAddSkills is provided, and fires it (ADR-0027 Phase 6a)", () => {
    const { rerender } = render(<AgentPersonaHeader {...base} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Skills" })).not.toBeInTheDocument();

    const onAddSkills = vi.fn();
    rerender(<AgentPersonaHeader {...base} onAddSkills={onAddSkills} skillsActive onClose={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "Skills" });
    expect(btn).toHaveAttribute("data-active", "true");
    fireEvent.click(btn);
    expect(onAddSkills).toHaveBeenCalledOnce();
  });
});
