import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: () => null,
    NodeResizer: () => null,
  };
});

vi.mock("@/modules/codecanvas/hooks/useCanvasLodTier", () => ({ useCanvasLodTier: () => "full" }));
vi.mock("@/lib/tauri-api", () => ({
  isTauri: () => false,
  // useRunnerRegistry → listRunners; empty in jsdom (no Tauri).
  listRunners: vi.fn().mockResolvedValue({ runners: [] }),
}));

import { TeamNode } from "../nodes/TeamNode";
import type { CanvasTeamNodeData } from "../../types/canvas";

function makeProps(overrides?: Partial<CanvasTeamNodeData>) {
  return {
    id: "team-1",
    data: {
      cwd: "/repo",
      name: "Build Team",
      description: "Team run",
      goal: "Ship the task.",
      members: [{ id: "agent-1", name: "Coder", model: "claude", prompt: "Code", appliedSkills: [], updatedAt: 0 }],
      onClose: vi.fn(),
      onChange: vi.fn(),
      ...overrides,
    },
    selected: false,
  } as unknown as Parameters<typeof TeamNode>[0];
}

describe("TeamNode", () => {
  it("emits team commands through the node command seam", () => {
    const dispatchCommand = vi.fn();
    render(<TeamNode {...makeProps({ dispatchCommand, onClose: undefined, onChange: undefined })} />);

    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "Review Team" } });
    fireEvent.change(screen.getByLabelText("Team goal"), { target: { value: "Review the implementation." } });
    fireEvent.click(screen.getByRole("button", { name: "Close team node" }));

    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "patch-team", nodeId: "team-1", patch: { name: "Review Team" } });
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "patch-team", nodeId: "team-1", patch: { goal: "Review the implementation." } });
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "close-node", nodeId: "team-1" });
  });

  it("runs the team as a launch-set via the launch-team command (ADR-0027 Phase 6)", () => {
    const dispatchCommand = vi.fn();
    render(<TeamNode {...makeProps({ dispatchCommand, onClose: undefined, onChange: undefined })} />);

    fireEvent.click(screen.getByRole("button", { name: /Run Team/ }));

    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "launch-team", nodeId: "team-1" });
  });

  it("removes a runner slot through the patch-team seam", () => {
    const dispatchCommand = vi.fn();
    render(<TeamNode {...makeProps({ dispatchCommand, onClose: undefined, onChange: undefined })} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove Coder" }));

    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "patch-team", nodeId: "team-1", patch: { members: [] } });
  });

  it("disables Run Team with no runner slots", () => {
    render(<TeamNode {...makeProps({ members: [], dispatchCommand: vi.fn(), onClose: undefined, onChange: undefined })} />);
    expect(screen.getByRole("button", { name: /Run Team/ })).toBeDisabled();
  });
});
