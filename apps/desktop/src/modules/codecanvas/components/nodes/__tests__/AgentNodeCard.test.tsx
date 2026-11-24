import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentNodeCard } from "../AgentNodeCard";
import { EMPTY_RUN_VIEW, type AgentRunView } from "../../../services/agent-run-view";

const base = {
  name: "Frontend Specialist",
  model: "claude-sonnet-4-6",
  status: "idle" as const,
  view: EMPTY_RUN_VIEW,
  canReply: false,
  readonly: false,
  onRun: () => {},
  onStop: () => {},
  onClose: () => {},
  onReply: () => {},
};

describe("AgentNodeCard", () => {
  it("renders the agent name and model", () => {
    render(<AgentNodeCard {...base} />);
    expect(screen.getByText("Frontend Specialist")).toBeInTheDocument();
    expect(screen.getByText("claude-sonnet-4-6")).toBeInTheDocument();
  });

  it("runs when the Run button is clicked while idle", () => {
    const onRun = vi.fn();
    render(<AgentNodeCard {...base} onRun={onRun} />);
    fireEvent.click(screen.getByRole("button", { name: "Run agent" }));
    expect(onRun).toHaveBeenCalledOnce();
  });

  it("shows Stop instead of Run while busy and stops on click", () => {
    const onStop = vi.fn();
    render(<AgentNodeCard {...base} status="running" onStop={onStop} />);
    expect(screen.queryByRole("button", { name: "Run agent" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("shows the message prose and reveals tool activity only when toggled", () => {
    const view: AgentRunView = {
      entries: [
        { kind: "message", text: "Planning the change" },
        { kind: "tool", label: "Reading a.ts" },
      ],
    };
    render(<AgentNodeCard {...base} status="running" view={view} />);
    expect(screen.getByText("Planning the change")).toBeInTheDocument();
    // Tool activity is collapsed by default.
    expect(screen.queryByText("Reading a.ts")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show tool activity" }));
    expect(screen.getByText("Reading a.ts")).toBeInTheDocument();
  });

  it("exposes the status for styling and a11y", () => {
    render(<AgentNodeCard {...base} status="error" />);
    expect(screen.getByLabelText("Status: error")).toBeInTheDocument();
  });

  it("replaces the previous status badge when moving from completed to running", () => {
    const { rerender } = render(<AgentNodeCard {...base} status="completed" />);
    expect(screen.getByLabelText("Status: completed")).toBeInTheDocument();

    rerender(<AgentNodeCard {...base} status="running" />);

    expect(screen.getByLabelText("Status: running")).toBeInTheDocument();
    expect(screen.queryByLabelText("Status: completed")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".agent-status")).toHaveLength(1);
  });

  it("offers a reply box only when the agent can resume", () => {
    const { rerender } = render(<AgentNodeCard {...base} canReply={false} />);
    expect(screen.queryByLabelText("Reply to agent")).toBeNull();
    rerender(<AgentNodeCard {...base} status="completed" canReply />);
    expect(screen.getByLabelText("Reply to agent")).toBeInTheDocument();
  });

  it("marks the reply rail as the command delivery target", () => {
    const { container } = render(<AgentNodeCard {...base} status="completed" canReply deliveryTargetId="agent-1" />);
    expect(container.querySelector("[data-canvas-agent-delivery-target='agent-1']")).toBeInTheDocument();
  });

  it("summarizes run inputs so prompt scope is visible before running", () => {
    render(<AgentNodeCard {...base} contextCount={2} skillCount={1} imageCount={3} worktreeBranch="feature/card" />);
    expect(screen.getByLabelText("Run inputs")).toBeInTheDocument();
    expect(screen.getByText("context 2")).toBeInTheDocument();
    expect(screen.getByText("skills 1")).toBeInTheDocument();
    expect(screen.getByText("images 3")).toBeInTheDocument();
    expect(screen.getByText("WT feature/card")).toBeInTheDocument();
  });

  it("shows a read-only badge in safe permission mode", () => {
    const { rerender } = render(<AgentNodeCard {...base} readonly={false} />);
    expect(screen.queryByText("read-only")).toBeNull();
    rerender(<AgentNodeCard {...base} readonly />);
    expect(screen.getByText("read-only")).toBeInTheDocument();
  });

  it("shows a truncated session id with the full id on hover", () => {
    const { rerender } = render(<AgentNodeCard {...base} />);
    expect(screen.queryByText("abcd1234")).toBeNull();
    rerender(<AgentNodeCard {...base} sessionId="abcd1234-5678-90ab" />);
    expect(screen.getByText("abcd1234")).toBeInTheDocument();
    expect(screen.getByTitle("abcd1234-5678-90ab")).toBeInTheDocument();
  });

  it("offers Promote to Terminal and disables it while busy", () => {
    const onPromoteToTerminal = vi.fn();
    const { rerender } = render(<AgentNodeCard {...base} onPromoteToTerminal={onPromoteToTerminal} />);
    fireEvent.click(screen.getByRole("button", { name: "Promote to Terminal" }));
    expect(onPromoteToTerminal).toHaveBeenCalledOnce();

    rerender(<AgentNodeCard {...base} status="running" onPromoteToTerminal={onPromoteToTerminal} />);
    expect(screen.getByRole("button", { name: "Promote to Terminal" })).toBeDisabled();
  });

  it("sends a reply and clears the input", () => {
    const onReply = vi.fn();
    render(<AgentNodeCard {...base} status="completed" canReply onReply={onReply} />);
    const input = screen.getByLabelText("Reply to agent") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "continue please" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    expect(onReply).toHaveBeenCalledWith("continue please");
    expect(input.value).toBe("");
  });
});
