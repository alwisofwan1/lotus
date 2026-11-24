import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: () => null,
    NodeResizer: () => null,
  };
});

vi.mock("@/modules/codecanvas/hooks/useCanvasLodTier", () => ({
  useCanvasLodTier: () => "full",
}));

import { TaskNode } from "../nodes/TaskNode";
import type { CanvasTaskNodeData } from "../../types/canvas";

function makeProps(overrides?: Partial<CanvasTaskNodeData>) {
  return {
    id: "task-1",
    data: {
      title: "Build retro NASCAR Rumble game",
      description: "",
      status: "todo",
      priority: "none",
      cwd: "/repo",
      intent: "Create a retro-styled racing game inspired by NASCAR Rumble.",
      taskClass: "quick",
      when: "urgent",
      acceptanceCriteria: [
        { id: "c1", text: "Playable racing game", done: false },
        { id: "c2", text: "Retro visual style", done: false },
      ],
      onClose: vi.fn(),
      onChange: vi.fn(),
      onDispatch: vi.fn(),
      ...overrides,
    },
    selected: false,
  } as unknown as Parameters<typeof TaskNode>[0];
}

describe("TaskNode", () => {
  it("keeps long task content in an internal scroll region", () => {
    render(<TaskNode {...makeProps()} />);

    const scroll = screen.getByTestId("canvas-task-scroll");
    expect(scroll).toHaveClass("canvas-task-scroll", "nodrag", "nowheel");
    expect(scroll).toContainElement(screen.getByDisplayValue("Build retro NASCAR Rumble game"));
    expect(scroll).not.toContainElement(screen.getByRole("button", { name: "Run on canvas" }));
  });

  it("emits task commands through the node command seam", () => {
    const dispatchCommand = vi.fn();
    render(<TaskNode {...makeProps({ dispatchCommand, onClose: undefined, onChange: undefined, onDispatch: undefined })} />);

    fireEvent.change(screen.getByDisplayValue("Build retro NASCAR Rumble game"), { target: { value: "Ship canvas" } });
    fireEvent.click(screen.getByRole("button", { name: "Run on canvas" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Agent Team" }));
    fireEvent.click(screen.getByRole("button", { name: "Close task" }));

    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "patch-task", nodeId: "task-1", patch: { title: "Ship canvas" } });
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "dispatch-task", nodeId: "task-1", mode: "team" });
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "close-node", nodeId: "task-1" });
  });

  it("dispatches a single run as a runner (runner-first, defaults to claude with no registry) — ADR-0027 Phase 6", () => {
    const dispatchCommand = vi.fn();
    render(<TaskNode {...makeProps({ dispatchCommand, onClose: undefined, onChange: undefined, onDispatch: undefined })} />);
    fireEvent.click(screen.getByRole("button", { name: "Run on canvas" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Run with Claude" }));
    // No runner registry in jsdom → falls back to claude; carries runner, not a persona def.
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "dispatch-task", nodeId: "task-1", mode: "single", runner: "claude", runnerCommand: undefined });
  });

  it("copies a structured prompt for the task", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<TaskNode {...makeProps({ taskId: "30a83136-ba90-403b-9dec-e613e6513501", taskWorkspaceId: "ws-main" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy task prompt" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const prompt = writeText.mock.calls[0][0] as string;
    // Copy Prompt = task brief + completion callback, NO agent persona.
    expect(prompt).toContain("# Build retro NASCAR Rumble game");
    expect(prompt).toContain("Timeline: urgent");
    expect(prompt).toContain("## Intent\nCreate a retro-styled racing game inspired by NASCAR Rumble.");
    expect(prompt).toContain("## Acceptance criteria\n- [ ] Playable racing game\n- [ ] Retro visual style");
    expect(prompt).toContain(`PATCH "$AGENT_CANVAS_API/api/tasks/30a83136-ba90-403b-9dec-e613e6513501?workspaceId=ws-main"`);
    expect(prompt).not.toContain("You are the Coder");
    expect(prompt).not.toContain("# Task objective");
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy task prompt" })).toHaveTextContent("Copied"));
  });
});
