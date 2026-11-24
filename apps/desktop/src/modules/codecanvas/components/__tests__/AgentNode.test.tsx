import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: () => null,
    NodeResizer: () => null,
    useReactFlow: () => ({ getEdges: () => [], getNode: () => null }),
  };
});

vi.mock("@dnd-kit/core", () => ({
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
}));

vi.mock("@/modules/codecanvas/hooks/useCanvasLodTier", () => ({ useCanvasLodTier: () => "full" }));
vi.mock("@/modules/codecanvas/hooks/useAgentNodeState", () => ({
  useAgentNodeState: () => ({
    status: "idle",
    view: { items: [] },
    sessionId: null,
    canReply: false,
    start: vi.fn(),
    stop: vi.fn(),
    sendReply: vi.fn(),
  }),
}));
vi.mock("@/modules/codecanvas/hooks/useAgentNodeActions", () => ({
  useAgentNodeActions: () => ({
    activePanel: null,
    worktree: null,
    runCwd: "/repo",
    toggleWT: vi.fn(),
    toggleDiff: vi.fn(),
    closePanel: vi.fn(),
    assignWorktree: vi.fn(),
    unassignWorktree: vi.fn(),
  }),
}));
vi.mock("@/modules/codecanvas/hooks/useAgentRunRegistration", () => ({ useAgentRunRegistration: vi.fn() }));
vi.mock("@/modules/codecanvas/hooks/useAgentReplyRegistration", () => ({ useAgentReplyRegistration: vi.fn() }));
vi.mock("@/modules/codecanvas/hooks/useCanvasAttachments", () => ({ useCanvasAttachments: () => [] }));
vi.mock("@/modules/codecanvas/components/CanvasGraphRunProvider", () => ({
  useCanvasGraphRunContext: () => ({ replayable: false, running: false, replayFrom: vi.fn() }),
  useCanvasProjectId: () => "project-1",
}));
vi.mock("@/modules/codecanvas/services/canvas-upstream-context", () => ({ resolveUpstreamContext: () => [] }));
vi.mock("@/modules/codecanvas/services/note-assets", () => ({ resolveNoteAssetImageRefs: vi.fn(async () => []) }));
vi.mock("@/lib/tauri/app", () => ({ openPathInEditor: vi.fn() }));
vi.mock("../nodes/CanvasAttachmentStrip", () => ({ CanvasAttachmentStrip: () => null }));
// The live path owns a PTY/xterm runtime; this suite covers the headless dispatch only.
vi.mock("../nodes/LiveAgentNode", () => ({ LiveAgentNode: () => <div data-testid="live-agent-node" /> }));
vi.mock("../nodes/AgentNodeCard", () => ({
  AgentNodeCard: ({ onClose, onToggleSkills, onPromoteToTerminal }: {
    onClose: () => void;
    onToggleSkills?: () => void;
    onPromoteToTerminal?: () => void;
  }) => (
    <div data-testid="agent-node-card">
      <button type="button" onClick={onToggleSkills}>Skills</button>
      <button type="button" onClick={onPromoteToTerminal}>Promote</button>
      <button type="button" onClick={onClose}>Kill agent</button>
    </div>
  ),
}));

import { AgentNode } from "../nodes/AgentNode";
import type { CanvasAgentNodeData } from "../../types/canvas";

function makeProps(overrides?: Partial<CanvasAgentNodeData>) {
  return {
    id: "agent-1",
    data: {
      agentDefId: "def-1",
      name: "Coder",
      model: "claude-sonnet",
      cwd: "/repo",
      prompt: "Code the task.",
      appliedSkills: ["diagnose"],
      effort: "medium",
      permissionMode: "full",
      onClose: vi.fn(),
      onAddSkillsNode: vi.fn(),
      onPromoteToTerminal: vi.fn(),
      ...overrides,
    },
    selected: false,
  } as unknown as Parameters<typeof AgentNode>[0];
}

describe("AgentNode", () => {
  it("emits agent commands through the node command seam", () => {
    const dispatchCommand = vi.fn();
    render(<AgentNode {...makeProps({ dispatchCommand, onClose: undefined, onAddSkillsNode: undefined, onPromoteToTerminal: undefined })} />);

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "Promote" }));
    fireEvent.click(screen.getByRole("button", { name: "Kill agent" }));

    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "agent-add-skills", agentId: "agent-1", cwd: "/repo" });
    expect(dispatchCommand).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent-promote-to-terminal", agentId: "agent-1" }));
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "close-node", nodeId: "agent-1" });
  });

  it("dispatches on execution mode: headless (default) renders the headless card", () => {
    render(<AgentNode {...makeProps()} />);
    expect(screen.getByTestId("agent-node-card")).toBeInTheDocument();
    expect(screen.queryByTestId("live-agent-node")).not.toBeInTheDocument();
  });

  it("dispatches on execution mode: live renders the live PTY persona (ADR-0022)", () => {
    render(<AgentNode {...makeProps({ executionMode: "live" })} />);
    expect(screen.getByTestId("live-agent-node")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-node-card")).not.toBeInTheDocument();
  });
});
