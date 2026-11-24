import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentDiffPanel } from "../AgentDiffPanel";

const DIFF = ["@@ -1 +1 @@", "-const b = 2;", "+const b = 3;"].join("\n");

describe("AgentDiffPanel", () => {
  it("loads the diff for the agent's run directory", async () => {
    const loadDiff = vi.fn().mockResolvedValue(DIFF);
    render(<AgentDiffPanel cwd="/repo/.wt/x" loadDiff={loadDiff} onClose={() => {}} />);
    expect(loadDiff).toHaveBeenCalledWith("/repo/.wt/x");
    expect(await screen.findByText("+const b = 3;")).toBeInTheDocument();
  });

  it("tags added and removed lines so they can be coloured", async () => {
    const loadDiff = vi.fn().mockResolvedValue(DIFF);
    render(<AgentDiffPanel cwd="/repo" loadDiff={loadDiff} onClose={() => {}} />);
    const added = await screen.findByText("+const b = 3;");
    expect(added).toHaveClass("agent-diff-line--add");
    expect(screen.getByText("-const b = 2;")).toHaveClass("agent-diff-line--del");
  });

  it("shows a clean-tree message when there are no changes", async () => {
    const loadDiff = vi.fn().mockResolvedValue("");
    render(<AgentDiffPanel cwd="/repo" loadDiff={loadDiff} onClose={() => {}} />);
    expect(await screen.findByText(/no uncommitted changes/i)).toBeInTheDocument();
  });

  it("closes when the close button is clicked", async () => {
    const onClose = vi.fn();
    render(<AgentDiffPanel cwd="/repo" loadDiff={() => Promise.resolve("")} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
