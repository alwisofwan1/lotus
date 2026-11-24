import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { TaskNode } from "../TaskNode";
import type { CanvasTaskNodeData } from "../../../types/canvas";

function renderNode(overrides: Partial<CanvasTaskNodeData> = {}) {
  const onDispatch = vi.fn();
  const onChange = vi.fn();
  const onClose = vi.fn();
  const data: CanvasTaskNodeData = {
    title: "Add OAuth login",
    description: "Wire Google OAuth into the sign-in flow",
    status: "todo",
    priority: "high",
    cwd: "/repo",
    onDispatch,
    onChange,
    onClose,
    ...overrides,
  };
  render(
    <ReactFlowProvider>
      <TaskNode id="task-1" data={data as unknown as Record<string, unknown>} selected={false} type="task"
        dragging={false} zIndex={0} isConnectable positionAbsoluteX={0} positionAbsoluteY={0} deletable selectable draggable />
    </ReactFlowProvider>,
  );
  return { onDispatch, onChange, onClose };
}

describe("TaskNode", () => {
  it("renders the title, status and priority", () => {
    renderNode();
    expect(screen.getByDisplayValue("Add OAuth login")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Status: Todo" })).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
  });

  it("dispatches the task to a single live agent (optionally a picked def)", () => {
    const { onDispatch } = renderNode();
    fireEvent.click(screen.getByRole("button", { name: "Run on canvas" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /run with claude/i }));
    const call = onDispatch.mock.calls.at(-1);
    expect(call?.[0]).toBe("task-1");
    expect(call?.[1]).toBe("single");
  });

  it("dispatches an agent team", () => {
    const { onDispatch } = renderNode();
    fireEvent.click(screen.getByRole("button", { name: "Run on canvas" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /agent team/i }));
    const call = onDispatch.mock.calls.at(-1);
    expect(call?.[0]).toBe("task-1");
    expect(call?.[1]).toBe("team");
  });

  it("sets its own status from the tracker's menu, never a native select", () => {
    const { onChange } = renderNode();
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Status: Todo" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /in review/i }));
    expect(onChange).toHaveBeenCalledWith("task-1", { status: "in-review" });
  });

  it("edits the title through onChange", () => {
    const { onChange } = renderNode();
    fireEvent.change(screen.getByDisplayValue("Add OAuth login"), { target: { value: "Add SSO" } });
    expect(onChange).toHaveBeenCalledWith("task-1", { title: "Add SSO" });
  });

  it("closes the node", () => {
    const { onClose } = renderNode();
    fireEvent.click(screen.getByRole("button", { name: /close task/i }));
    expect(onClose).toHaveBeenCalledWith("task-1");
  });
});
