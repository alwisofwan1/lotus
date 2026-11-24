import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import { TasksSurface } from "@/modules/tasks/containers/TasksSurface";
import { DEFAULT_LAYOUT } from "@/modules/workspace-shell/services/layout-preferences";
import type { TrackerBoard } from "@/modules/tasks/hooks/useTrackerBoard";
import type { BridgeTask } from "@/modules/codespace/services/bridge/task-store";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";

/**
 * A Lotus task edited on its own page — title, brief and knowledge — the way a vault ticket
 * already could be. The page was read-only for these, so a task in any workspace was frozen in
 * exactly the place its ticket twin was editable.
 */

const NO_VAULT = { path: "", connect: () => {}, disconnect: () => {} };
const project: TrackerProject = { id: "ws-1", name: "Test 2", prefix: "T2", vocabulary: LOTUS_VOCABULARY };
const row: TrackerTask = {
  id: "t1", projectId: "ws-1", number: 4, title: "Fix the login spec",
  status: "todo", priority: "none", createdAt: 1, updatedAt: 1,
};
const stored: BridgeTask = {
  id: "t1", workspaceId: "ws-1", number: 4, title: "Fix the login spec",
  goal: "Make it pass ten times in a row", knowledge: "Fails on CI only",
  status: "todo", priority: "none", assignees: [], createdAt: 1, updatedAt: 1,
};

function setup(overrides: Partial<TrackerBoard> = {}) {
  const board: TrackerBoard = {
    projects: [project],
    projectsById: new Map([[project.id, project]]),
    tasks: [row],
    loading: false,
    error: null,
    refresh: vi.fn(),
    createFromTicket: vi.fn(async () => null),
    createTask: vi.fn(async () => null),
    editTask: vi.fn(async () => null),
    editTaskBody: vi.fn(async () => null),
    openTask: vi.fn(async () => ({ kind: "task" as const, task: stored })),
    lastChange: null,
    ...overrides,
  };
  const surface = (b: TrackerBoard) => (
    <TasksSurface vault={NO_VAULT} spawner={null} activities={new Map()} board={b}
      layout={DEFAULT_LAYOUT} onLayoutChange={vi.fn()} onClose={vi.fn()} />
  );
  const view = render(surface(board));
  return { board, rerender: (b: TrackerBoard) => view.rerender(surface(b)) };
}

async function openTask() {
  fireEvent.click(screen.getByRole("button", { name: row.title }));
  await screen.findByRole("textbox", { name: "Task title" }, { timeout: 10_000 });
}

/** The TipTap editor mounted for one field, found by the placeholder-bearing section it sits in. */
async function editorIn(label: string): Promise<Editor> {
  return waitFor(() => {
    const section = screen.getByRole("region", { name: label });
    const el = section.querySelector(".tk-editor") as (HTMLElement & { editor?: Editor }) | null;
    if (!el?.editor) throw new Error(`${label} editor not mounted yet`);
    return el.editor;
  });
}

describe("editing a Lotus task on its own page", { timeout: 20_000 }, () => {
  it("renames it when the title is left", async () => {
    const { board } = setup();
    await openTask();

    const title = screen.getByRole("textbox", { name: "Task title" });
    title.textContent = "Fix the flaky login spec";
    fireEvent.blur(title);

    expect(board.editTask).toHaveBeenCalledWith("t1", { title: "Fix the flaky login spec" });
  });

  it("autosaves the brief after a pause", async () => {
    const { board } = setup();
    await openTask();
    const brief = await editorIn("Brief");

    vi.useFakeTimers();
    try {
      act(() => {
        brief.commands.setContent("<p>Make it pass on CI.</p>");
      });
      expect(board.editTaskBody).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(board.editTaskBody).toHaveBeenCalledWith("ws-1", "t1", { goal: "Make it pass on CI." });
  });

  it("refuses a brief past the store's 500 bytes, and says so rather than failing quietly", async () => {
    const { board } = setup();
    await openTask();
    const brief = await editorIn("Brief");

    vi.useFakeTimers();
    try {
      act(() => {
        brief.commands.setContent(`<p>${"Gagal — ".repeat(80)}</p>`);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(board.editTaskBody).not.toHaveBeenCalled();
    expect(screen.getByText(/at most 500 bytes/)).toBeTruthy();
  });

  it("keeps what is being typed when an agent writes to the task in the meantime", async () => {
    const reported = { ...stored, goal: "Written by the agent", updatedAt: 2 };
    const openTaskFn = vi
      .fn()
      .mockResolvedValueOnce({ kind: "task" as const, task: stored })
      .mockResolvedValue({ kind: "task" as const, task: reported });
    const { board, rerender } = setup({ openTask: openTaskFn });
    await openTask();
    const brief = await editorIn("Brief");

    act(() => {
      brief.commands.setContent("<p>Still typing this</p>");
    });
    rerender({ ...board, lastChange: { workspaceId: "ws-1", taskId: "t1", seq: 1 } });
    await waitFor(() => expect(openTaskFn).toHaveBeenCalledTimes(2));

    expect(brief.getText()).toContain("Still typing this");
    await waitFor(() =>
      expect(board.editTaskBody).toHaveBeenCalledWith("ws-1", "t1", { goal: "Still typing this" }),
    );
  });
});
