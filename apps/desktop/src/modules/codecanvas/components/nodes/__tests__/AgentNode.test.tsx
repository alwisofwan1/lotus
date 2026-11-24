import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { AgentNode } from "../AgentNode";

// ResizeObserver is required by ReactFlow but missing in jsdom.
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock("@/lib/tauri/canvas-git", () => ({
  listGitWorktrees: vi.fn().mockResolvedValue([]),
  createGitWorktree: vi.fn(),
  removeGitWorktree: vi.fn(),
  validateWorktreeBranches: vi.fn().mockResolvedValue([]),
}));

describe("AgentNode (mounted in a flow)", () => {
  it("renders the agent identity without crashing inside ReactFlow", () => {
    const nodes = [{
      id: "agent-1",
      type: "agent",
      position: { x: 0, y: 0 },
      data: { agentDefId: "d1", name: "Frontend Specialist", model: "claude-sonnet-4-6", cwd: "/repo", prompt: "build", onClose: () => {} },
    }];
    render(
      <ReactFlowProvider>
        <div style={{ width: 800, height: 600 }}>
          <ReactFlow nodes={nodes} edges={[]} nodeTypes={{ agent: AgentNode }} />
        </div>
      </ReactFlowProvider>,
    );
    expect(screen.getByText("Frontend Specialist")).toBeInTheDocument();
  });

  it("promotes the current agent configuration to a terminal payload", () => {
    const onPromoteToTerminal = vi.fn();
    const nodes = [{
      id: "agent-1",
      type: "agent",
      position: { x: 0, y: 0 },
      data: {
        agentDefId: "d1",
        name: "Frontend Specialist",
        model: "sonnet",
        cwd: "/repo",
        prompt: "build the UI",
        appliedSkills: ["diagnose"],
        effort: "high",
        permissionMode: "safe",
        onClose: () => {},
        onPromoteToTerminal,
      },
    }];

    render(
      <ReactFlowProvider>
        <div style={{ width: 800, height: 600 }}>
          <ReactFlow nodes={nodes} edges={[]} nodeTypes={{ agent: AgentNode }} />
        </div>
      </ReactFlowProvider>,
    );

    fireEvent.click(screen.getByLabelText("Promote to Terminal", { selector: "button" }));

    expect(onPromoteToTerminal).toHaveBeenCalledWith("agent-1", expect.objectContaining({
      name: "Frontend Specialist",
      model: "sonnet",
      rolePrompt: "build the UI",
      runCwd: "/repo",
      appliedSkills: ["diagnose"],
      effort: "high",
      skipPermissions: false,
    }));
  });

  describe("initialWorktree from node data", () => {
    const makeNodes = (extra: Record<string, unknown> = {}) => [{
      id: "agent-1",
      type: "agent",
      position: { x: 0, y: 0 },
      data: { agentDefId: "d1", name: "Dev", model: "claude-sonnet-4-6", cwd: "/repo", prompt: "go", onClose: () => {}, ...extra },
    }];

    it("shows base cwd in worktree panel when no assignedWorktree is in data", () => {
      const { container } = render(
        <ReactFlowProvider>
          <div style={{ width: 800, height: 600 }}>
            <ReactFlow nodes={makeNodes()} edges={[]} nodeTypes={{ agent: AgentNode }} />
          </div>
        </ReactFlowProvider>,
      );
      // WT button present — no worktree badge shown
      expect(container.querySelector("[aria-label='Worktree']")).toBeInTheDocument();
      expect(container.querySelector("[data-worktree-assigned]")).not.toBeInTheDocument();
    });

    it("reads assignedWorktree and assignedWorktreePath from node data as initialWorktree", () => {
      const { container } = render(
        <ReactFlowProvider>
          <div style={{ width: 800, height: 600 }}>
            <ReactFlow
              nodes={makeNodes({ assignedWorktree: "feat/auth", assignedWorktreePath: "/repo-wt/feat-auth" })}
              edges={[]}
              nodeTypes={{ agent: AgentNode }}
            />
          </div>
        </ReactFlowProvider>,
      );
      // AgentNodeCard renders a "WT <branch>" chip when a worktree is assigned via initialWorktree.
      expect(container.querySelector(".agent-card-chip--worktree")?.textContent).toBe("WT feat/auth");
    });
  });
});
