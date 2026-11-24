import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import type { SharedTrackerBoard } from "@/modules/workspace-shell/hooks/TrackerBoardProvider";
import type { TrackerTask } from "@/modules/tasks/types";
import { GITHUB_ISSUE_WRITE_DENY_RULES, namesakeCheckoutNote } from "@/modules/tasks/services/github-delegation";

const delegate = vi.fn(async () => null);
const delegationArgs: unknown[][] = [];
vi.mock("@/modules/tasks/hooks/useDelegation", () => ({
  useDelegation: (...args: unknown[]) => {
    delegationArgs.push(args);
    return { presets: [{ id: "p1", name: "Alwi", agent: "claude", args: "", instructions: "" }], delegate, inFlight: new Set() };
  },
}));

const { useCanvasTaskLinks } = await import("../useCanvasTaskLinks");
const { EACH_TASK_WORKSPACE } = await import("@/modules/codespace/services/task-execution/useTaskExecution");

const task: TrackerTask = {
  id: "task_12", projectId: "ws-flow", number: 12, title: "Rilis 2", status: "in-progress", priority: "high",
  createdAt: 1, updatedAt: 1, cellId: "canvas:cp_1:term-1", sourceRef: "donisapu/e-coursetradding#18",
};
const stored = { id: "task_12", workspaceId: "ws-flow", title: "Rilis 2", source: { kind: "github", ref: "donisapu/e-coursetradding#18", label: "#18" } };
const project = { id: "ws-flow", name: "Flow Trader", prefix: "FT", vocabulary: { order: [], labels: {}, tones: {}, open: [] } };

function shared(overrides: Partial<SharedTrackerBoard["board"]> = {}): SharedTrackerBoard {
  return {
    board: {
      projects: [project],
      projectsById: new Map([[project.id, project]]),
      tasks: [task],
      loading: false,
      error: null,
      refresh: vi.fn(),
      createTask: vi.fn(),
      createFromTicket: vi.fn(async () => ({ id: "task_new", workspaceId: "ws-flow" })),
      openTask: vi.fn(async () => ({ kind: "task", task: stored })),
      editTask: vi.fn(async () => null),
      ...overrides,
    },
    activities: new Map([["canvas:cp_1:term-1", { activity: "needs-you", since: 5 }]]),
    workspaceFolders: () => [{ id: "ws-flow", cwd: "/clients/flow-trader", remote: false }],
  } as unknown as SharedTrackerBoard;
}

const terminal = { id: "term-1", type: "terminal", position: { x: 0, y: 0 }, data: { runtimePaneId: "canvas:cp_1:term-1", launchCommand: ["/usr/bin/claude", "--session-id", "s"] } } as Node;
const linked = { id: "node-1", type: "task", position: { x: 0, y: 0 }, data: { taskId: "task_12", title: "old", status: "todo", priority: "none", description: "" } } as Node;
const local = { id: "node-2", type: "task", position: { x: 0, y: 0 }, data: { title: "Write the note", description: "", status: "todo", priority: "low", acceptanceCriteria: [{ id: "c", text: "Reviewed", done: false }] } } as Node;

function setup(board = shared(), findCheckout = vi.fn(async () => null as never)) {
  const patchNodeData = vi.fn();
  const openInDock = vi.fn();
  const hook = renderHook(() =>
    useCanvasTaskLinks({
      nodes: [terminal, linked, local],
      shared: board,
      spawner: { addPane: vi.fn() },
      rootDir: "/clients/flow-trader/",
      openInDock,
      patchNodeData,
      unavailable: "not here",
      findCheckout,
    }),
  );
  return { ...hook, patchNodeData, openInDock, board };
}

describe("useCanvasTaskLinks (board 18)", () => {
  it("reads a task, its key, its workspace and what its pane on this canvas is doing", () => {
    const { result } = setup();
    const links = result.current!;
    expect(links.task("task_12")).toBe(task);
    expect(links.taskKey(task)).toBe("FT-12");
    expect(links.projectName("ws-flow")).toBe("Flow Trader");
    expect(links.live(task)).toEqual({ state: { activity: "needs-you", since: 5 }, nodeId: "term-1", label: "claude" });
    expect(links.boardWorkspace).toEqual({ id: "ws-flow", name: "Flow Trader" });
    // No one host workspace: each task brings its own.
    expect(delegationArgs.at(-1)![0]).toBe(EACH_TASK_WORKSPACE);
  });

  it("keeps a linked node's own copy following the task", () => {
    const { patchNodeData } = setup();
    expect(patchNodeData).toHaveBeenCalledWith("node-1", { title: "Rilis 2", status: "in-progress", priority: "high" });
    expect(patchNodeData).not.toHaveBeenCalledWith("node-2", expect.anything());
  });

  it("writes status through the board", () => {
    const { result, board } = setup();
    act(() => result.current!.setStatus(task, "blocked"));
    expect(board.board.editTask).toHaveBeenCalledWith("task_12", { status: "blocked" });
  });

  it("delegates the stored task with the deny rules and note Tasks would give it", async () => {
    const findCheckout = vi.fn(async () => ({ workspaceId: "ws-flow", cwd: "/clients/flow-trader", namesake: "mapantekno/e-coursetradding" }));
    const { result } = setup(shared(), findCheckout as never);
    const preset = result.current!.presets[0]!;
    await act(async () => {
      await result.current!.delegate(task, preset);
    });
    expect(findCheckout).toHaveBeenCalledWith("donisapu/e-coursetradding", [{ id: "ws-flow", cwd: "/clients/flow-trader" }], "ws-flow", { namesake: true });
    expect(delegate).toHaveBeenCalledWith(stored, preset, "FT-12", {
      denyTools: GITHUB_ISSUE_WRITE_DENY_RULES,
      note: namesakeCheckoutNote("donisapu/e-coursetradding", "mapantekno/e-coursetradding"),
    });
  });

  it("files a local node in the board's workspace and links it", async () => {
    const { result, board, patchNodeData } = setup();
    let message: string | null = "unset";
    await act(async () => {
      message = await result.current!.addToTasks("node-2");
    });
    expect(message).toBeNull();
    expect(board.board.createFromTicket).toHaveBeenCalledWith("ws-flow", {
      title: "Write the note",
      goal: "Write the note",
      knowledge: "Acceptance criteria\n- [ ] Reviewed",
      status: "todo",
      priority: "low",
    });
    await waitFor(() => expect(patchNodeData).toHaveBeenCalledWith("node-2", { taskId: "task_new", taskWorkspaceId: "ws-flow" }));
  });

  it("says where to start when the board's folder is no workspace", async () => {
    const board = shared();
    (board as { workspaceFolders: () => unknown[] }).workspaceFolders = () => [];
    const { result } = setup(board);
    expect(result.current!.boardWorkspace).toBeNull();
    await expect(result.current!.addToTasks("node-2")).resolves.toMatch(/workspace in Code first/);
  });
});
