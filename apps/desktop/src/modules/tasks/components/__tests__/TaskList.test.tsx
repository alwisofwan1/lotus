import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VAULT_VOCABULARY } from "@/modules/tasks/services/vault-vocabulary";
import { VAULT_CAPABILITIES } from "@/modules/tasks/services/vault-mapping";
import { TaskList } from "@/modules/tasks/components/TaskList";
import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import { groupTasksByStatus } from "@/modules/tasks/services/task-list";
import { indexProjects } from "@/modules/tasks/services/task-mapping";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";

const PROJECTS: TrackerProject[] = [
  { id: "ws-1", name: "interview-hss", prefix: "IH", color: "#2BB8A5", vocabulary: LOTUS_VOCABULARY },
];

const TASKS: TrackerTask[] = [
  {
    id: "t1",
    projectId: "ws-1",
    number: 2,
    title: "CodeCanvas session refactor",
    status: "in-progress",
    priority: "high",
    createdAt: 1,
    updatedAt: 2,
  },
  {
    id: "t2",
    projectId: "ws-1",
    number: 1,
    title: "Write the plan",
    status: "todo",
    priority: "low",
    createdAt: 1,
    updatedAt: 1,
  },
];

function renderList(tasks: TrackerTask[] = TASKS) {
  const projectsById = indexProjects(PROJECTS);
  return render(
    <TaskList
      sections={groupTasksByStatus(tasks, "priority", LOTUS_VOCABULARY)}
      projectsById={projectsById}
      keyOf={(task) => {
        const project = projectsById.get(task.projectId);
        return project && task.number ? `${project.prefix}-${task.number}` : null;
      }}
      empty="Nothing here"
    />,
  );
}

describe("the task list", () => {
  it("prints the key beside the title, which is what makes a task sayable", () => {
    renderList();
    expect(screen.getByText("IH-2")).toBeInTheDocument();
    expect(screen.getByText("CodeCanvas session refactor")).toBeInTheDocument();
  });

  it("splits into sections that name their state and count their rows", () => {
    renderList();
    const heads = [...document.querySelectorAll(".tk-section-head")].map((node) =>
      node.textContent?.replace(/\s+/g, " ").trim(),
    );
    // Work in flight above work that has not started.
    // The glyph is decorative in a header, so the state is named once, not twice.
    expect(heads).toEqual(["In Progress1", "Todo1"]);
  });

  it("says each mark out loud, because five circles are a distinction only the eye makes", () => {
    renderList();
    expect(screen.getAllByTitle("In Progress").length).toBeGreaterThan(0);
    expect(screen.getByTitle("High")).toBeInTheDocument();
    expect(screen.getByTitle("Low")).toBeInTheDocument();
  });

  it("keeps the key column for a task that has no number yet", () => {
    // Rows whose ids slid left and right as the store caught up would look like the list was
    // rearranging itself.
    renderList([{ ...TASKS[0], number: undefined }]);
    const key = document.querySelector(".tk-row-key");
    expect(key).toBeInTheDocument();
    expect(key?.textContent).toBe("");
  });

  it("draws the empty line when nothing survived, rather than an empty frame", () => {
    renderList([]);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });
});

describe("what the pane on each row is doing", () => {
  const bound = (id: string, cellId: string): TrackerTask => ({ ...TASKS[0], id, number: Number(id.slice(1)), title: `Task ${id}`, cellId });

  function renderWithPanes(
    tasks: TrackerTask[],
    panes: Record<string, "working" | "needs-you" | "failed" | "idle">,
    agentJump?: Parameters<typeof TaskList>[0]["agentJump"],
  ) {
    const projectsById = indexProjects(PROJECTS);
    return render(
      <TaskList
        sections={groupTasksByStatus(tasks, "priority", LOTUS_VOCABULARY)}
        projectsById={projectsById}
        keyOf={() => null}
        agentJump={agentJump}
        activities={new Map(Object.entries(panes).map(([id, activity]) => [id, { activity, since: 0 }]))}
        empty="Nothing here"
      />,
    );
  }

  it("marks a row whose agent is working, waiting on you, or has failed", () => {
    renderWithPanes(
      [bound("t1", "p1"), bound("t2", "p2"), bound("t3", "p3")],
      { p1: "working", p2: "needs-you", p3: "failed" },
    );

    expect(screen.getByLabelText("Agent working")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent needs you")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent failed")).toBeInTheDocument();
  });

  it("marks nothing where no pane is on the task — or the pane it names is gone", () => {
    renderWithPanes([{ ...TASKS[1] }, bound("t4", "gone")], {});

    expect(document.querySelector(".tk-row-live")).toBeNull();
  });

  it("makes the badge the way to its agent where the host can show that pane (LOT2-220)", () => {
    const show = vi.fn();
    const tasks = [bound("t1", "p1"), bound("t2", "p2")];
    renderWithPanes(tasks, { p1: "working", p2: "needs-you" }, { label: "Show agent on canvas", has: (id) => id === "p1", show });

    fireEvent.click(screen.getByRole("button", { name: "Agent working: show agent on canvas" }));
    expect(show).toHaveBeenCalledWith(tasks[0]);
    // A pane this host cannot reach keeps a plain label: no button that goes nowhere.
    expect(screen.queryByRole("button", { name: /Agent needs you/ })).toBeNull();
    expect(screen.getByLabelText("Agent needs you")).toBeInTheDocument();
  });
});

describe("a vault row", () => {
  const vault: TrackerProject = {
    id: "vault", name: "orbit-vault", prefix: "", vocabulary: VAULT_VOCABULARY, capabilities: VAULT_CAPABILITIES,
  };
  const ticket: TrackerTask = {
    id: "TKT-874.md", projectId: "vault", key: "TKT-874", title: "Remove legacy module",
    status: "in-review", priority: "none", createdAt: 1, updatedAt: 1,
  };

  function renderVault() {
    const onEdit = vi.fn();
    render(
      <TaskList
        sections={groupTasksByStatus([ticket], "priority", VAULT_VOCABULARY)}
        vocabulary={VAULT_VOCABULARY}
        projectsById={indexProjects([vault])}
        keyOf={(task) => task.key ?? null}
        onEdit={onEdit}
        empty="Nothing here"
      />,
    );
    return { onEdit };
  }

  it("offers its status in the vault's own words, and says the change", () => {
    const { onEdit } = renderVault();

    fireEvent.click(screen.getByLabelText("Status: In Review"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "QA Revision" }));

    expect(onEdit).toHaveBeenCalledWith("TKT-874.md", { status: "qa-revision" });
  });

  it("offers no priority — a ticket has none", () => {
    renderVault();

    expect(screen.queryByLabelText(/^Priority:/)).toBeNull();
  });
});

describe("a row with a node on the canvas beside the Dock (board 18)", () => {
  it("wears on canvas, and pressing it asks for that node", () => {
    const projectsById = indexProjects(PROJECTS);
    const onRevealOnCanvas = vi.fn();
    render(
      <TaskList
        sections={groupTasksByStatus(TASKS, "priority", LOTUS_VOCABULARY)}
        projectsById={projectsById}
        keyOf={() => null}
        empty="Nothing here"
        onCanvasIds={new Set(["t2"])}
        onRevealOnCanvas={onRevealOnCanvas}
      />,
    );
    const marks = screen.getAllByRole("button", { name: "On canvas: show its node" });
    expect(marks).toHaveLength(1);
    fireEvent.click(marks[0]!);
    expect(onRevealOnCanvas).toHaveBeenCalledWith(TASKS[1]);
  });
});
