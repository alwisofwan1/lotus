import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within, cleanup } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { TaskNode } from "../TaskNode";
import { CanvasTaskLinksContext, type CanvasTaskLinks } from "../canvas-task-links-context";
import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import type { TrackerTask } from "@/modules/tasks/types";
import type { CanvasTaskNodeData } from "../../../types/canvas";

/** Board 18 (plans/canvas-dock): a Task node linked to a task reads and writes it through the board. */

const task: TrackerTask = {
  id: "task_12",
  projectId: "ws-flow",
  number: 12,
  title: "#18 — Rilis 2 — backlog",
  status: "in-progress",
  priority: "high",
  createdAt: 1,
  updatedAt: Date.now() - 2 * 60_000,
  cellId: "canvas:cp_1:term-1",
  sourceRef: "donisapu/e-coursetradding#18",
};
const alwi = { id: "p1", name: "Alwi", agent: "claude", args: "", instructions: "" };

function links(overrides: Partial<CanvasTaskLinks> = {}): CanvasTaskLinks {
  return {
    loaded: true,
    task: (id) => (id === task.id ? task : undefined),
    taskKey: () => "FT-12",
    projectName: () => "Flow Trader",
    vocabulary: () => LOTUS_VOCABULARY,
    live: () => ({ state: { activity: "working", since: Date.now() - 4 * 60_000 }, nodeId: "term-1", label: "claude" }),
    setStatus: vi.fn(),
    setTitle: vi.fn(),
    presets: [alwi],
    delegateUnavailable: null,
    inFlight: () => false,
    delegate: vi.fn(async () => null),
    openInDock: vi.fn(),
    boardWorkspace: { id: "ws-flow", name: "Flow Trader" },
    addToTasks: vi.fn(async () => null),
    ...overrides,
  };
}

function renderNode(value: CanvasTaskLinks, overrides: Partial<CanvasTaskNodeData> = {}, selected = false) {
  const dispatchCommand = vi.fn();
  const data: CanvasTaskNodeData = {
    title: "stale copy",
    description: "",
    status: "todo",
    priority: "none",
    cwd: "/repo",
    taskId: task.id,
    taskWorkspaceId: task.projectId,
    dispatchCommand,
    ...overrides,
  };
  render(
    <ReactFlowProvider>
      <CanvasTaskLinksContext.Provider value={value}>
        <TaskNode id="node-1" data={data as unknown as Record<string, unknown>} selected={selected} type="task"
          dragging={false} zIndex={0} isConnectable positionAbsoluteX={0} positionAbsoluteY={0} deletable selectable draggable />
      </CanvasTaskLinksContext.Provider>
    </ReactFlowProvider>,
  );
  return { dispatchCommand };
}

describe("a linked Task node", () => {
  it("shows the task as Tasks has it, not the node's own copy", () => {
    renderNode(links());
    expect(screen.getByDisplayValue(task.title)).toBeInTheDocument();
    expect(screen.queryByDisplayValue("stale copy")).toBeNull();
    expect(screen.getByText("· FT-12")).toBeInTheDocument();
    expect(screen.getByText("#18")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Status: In Progress" })).toBeInTheDocument();
    expect(screen.getByText(/in Tasks · Flow Trader · 2m/)).toBeInTheDocument();
  });

  it("writes a status picked from the menu, by its number key too, to the task", () => {
    const value = links();
    renderNode(value);
    fireEvent.click(screen.getByRole("button", { name: "Status: In Progress" }));
    const menu = screen.getByRole("menu", { name: "Set status" });
    // The tracker's order: Todo, In Progress, Blocked, In Review, Done, Canceled → 4 is In Review.
    const fourth = within(menu).getAllByRole("menuitemradio")[3]!;
    fireEvent.keyDown(fourth, { key: "4" });
    expect(value.setStatus).toHaveBeenCalledWith(task, LOTUS_VOCABULARY.order[3]);
    expect(screen.queryByRole("menu", { name: "Set status" })).toBeNull();
  });

  it("opens its status menu on S while selected, never while typing or unselected", () => {
    renderNode(links());
    fireEvent.keyDown(window, { key: "s" });
    expect(screen.queryByRole("menu", { name: "Set status" })).toBeNull();
    cleanup();

    renderNode(links(), {}, true);
    fireEvent.keyDown(screen.getByDisplayValue(task.title), { key: "s" });
    expect(screen.queryByRole("menu", { name: "Set status" })).toBeNull();
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    expect(screen.queryByRole("menu", { name: "Set status" })).toBeNull();
    fireEvent.keyDown(window, { key: "s" });
    expect(screen.getByRole("menu", { name: "Set status" })).toBeInTheDocument();
  });

  it("says what its agent is doing, and shows that agent on the canvas", () => {
    const { dispatchCommand } = renderNode(links());
    expect(screen.getByText("claude")).toBeInTheDocument();
    expect(screen.getByText(/· 4m/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show its agent" }));
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "focus-node", nodeId: "term-1" });
  });

  it("delegates with a Tasks preset in one click, and keeps Agent Team under the chevron", async () => {
    const value = links();
    const { dispatchCommand } = renderNode(value);
    fireEvent.click(screen.getByRole("button", { name: /Delegate · Alwi/ }));
    await waitFor(() => expect(value.delegate).toHaveBeenCalledWith(task, alwi));
    fireEvent.click(screen.getByRole("button", { name: "Delegate with" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Agent Team/ }));
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "dispatch-task", nodeId: "node-1", mode: "team" });
  });

  it("says why a delegation did not happen", async () => {
    renderNode(links({ delegate: vi.fn(async () => "Only a Claude preset can be kept from writing to the ticket's source.") }));
    fireEvent.click(screen.getByRole("button", { name: /Delegate · Alwi/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only a Claude preset");
  });

  it("opens its row in the Dock's Tasks", () => {
    const value = links();
    renderNode(value);
    fireEvent.click(screen.getByRole("button", { name: "Open in Tasks" }));
    expect(value.openInDock).toHaveBeenCalledWith(task.id);
  });

  it("says so when its task is gone from Tasks, and can be unlinked", () => {
    const { dispatchCommand } = renderNode(links({ task: () => undefined }));
    expect(screen.getByText("Removed from Tasks")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delegate/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "patch-task", nodeId: "node-1", patch: { taskId: undefined, taskWorkspaceId: undefined } });
  });

  it("is not called removed while Tasks is still reading", () => {
    renderNode(links({ loaded: false, task: () => undefined }));
    expect(screen.queryByText("Removed from Tasks")).toBeNull();
    expect(screen.getByText(/reading Tasks/)).toBeInTheDocument();
  });
});

describe("a local Task node", () => {
  it("files itself in the board's workspace with Add to Tasks", async () => {
    const value = links();
    renderNode(value, { taskId: undefined, taskWorkspaceId: undefined, title: "Write the release note" });
    expect(screen.getByText("on this canvas only")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add to Tasks/ }));
    await waitFor(() => expect(value.addToTasks).toHaveBeenCalledWith("node-1"));
  });
});
