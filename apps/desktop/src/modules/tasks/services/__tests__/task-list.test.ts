import { describe, expect, it } from "vitest";
import {
  countTasks,
  groupTasksByProject,
  filterTasks,
  groupTasksByStatus,
  isActiveTask,
  reorderWrites,
  sortTasks,
  vocabularyByProject,
} from "@/modules/tasks/services/task-list";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";
import { LOTUS_VOCABULARY, type StatusVocabulary } from "@/modules/tasks/services/task-vocabulary";
import { VAULT_VOCABULARY } from "@/modules/tasks/services/vault-vocabulary";
import { VAULT_CAPABILITIES } from "@/modules/tasks/services/vault-mapping";
import type { BridgeTaskStatus } from "@/modules/codespace/services/bridge/task-store";

function task(overrides: Partial<TrackerTask> & { id: string }): TrackerTask {
  return {
    projectId: "ws-1",
    title: "A task",
    status: "todo",
    priority: "none",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("filtering", () => {
  const tasks = [
    task({ id: "a", status: "in-progress", priority: "high", title: "Fix the rail" }),
    task({ id: "b", status: "todo", priority: "low", title: "Write the plan" }),
    task({ id: "c", status: "complete", priority: "medium", projectId: "ws-2" }),
  ];

  it("treats an empty chip as no filter at all", () => {
    // Someone who opens the Status menu and closes it without choosing must get their list back.
    expect(filterTasks(tasks, { statuses: new Set() })).toHaveLength(3);
    expect(filterTasks(tasks, {})).toHaveLength(3);
  });

  it("keeps only the chosen statuses, priorities and projects", () => {
    expect(filterTasks(tasks, { statuses: new Set<BridgeTaskStatus>(["todo"]) }).map((t) => t.id)).toEqual(["b"]);
    expect(filterTasks(tasks, { priorities: new Set(["high"]) }).map((t) => t.id)).toEqual(["a"]);
    expect(filterTasks(tasks, { projectIds: new Set(["ws-2"]) }).map((t) => t.id)).toEqual(["c"]);
  });

  it("hides finished work when asked, and counts review as unfinished", () => {
    const withReview = [...tasks, task({ id: "d", status: "in-review" })];
    expect(filterTasks(withReview, { openOnly: true }).map((t) => t.id)).toEqual(["a", "b", "d"]);
  });

  it("searches the title and the key", () => {
    const keyOf = (candidate: TrackerTask) => (candidate.id === "a" ? "INT-2" : null);
    expect(filterTasks(tasks, { query: "rail" }, { keyOf }).map((t) => t.id)).toEqual(["a"]);
    expect(filterTasks(tasks, { query: "int-2" }, { keyOf }).map((t) => t.id)).toEqual(["a"]);
    expect(filterTasks(tasks, { query: "  " }, { keyOf })).toHaveLength(3);
  });
});

describe("counting what is really running", () => {
  const panes = (entries: Record<string, "working" | "done" | "failed" | "idle">) =>
    new Map(Object.entries(entries).map(([id, activity]) => [id, { activity, since: 0 }]));

  /*
    `cellId` is written on dispatch and nothing ever takes it back, so counting it as "active"
    counts every task that was EVER dispatched — including ones whose pane died when the app last
    closed. The count is meant to answer "what is moving right now".
  */
  it("does not count a task whose pane is no longer here", () => {
    const tasks = [
      task({ id: "live", status: "in-progress", cellId: "p1" }),
      task({ id: "ghost", status: "in-progress", cellId: "gone" }),
    ];

    expect(countTasks(tasks, () => LOTUS_VOCABULARY, panes({ p1: "working" })).active).toBe(1);
  });

  it("does not count a pane that has already finished or failed", () => {
    const tasks = [
      task({ id: "a", status: "in-progress", cellId: "p1" }),
      task({ id: "b", status: "in-progress", cellId: "p2" }),
    ];

    expect(
      countTasks(tasks, () => LOTUS_VOCABULARY, panes({ p1: "done", p2: "failed" })).active,
    ).toBe(0);
  });

  it("counts on the claim alone when nobody is watching the panes", () => {
    // Without a pane map there is nothing better to go on, and reporting zero would be a worse
    // answer than the old one.
    const tasks = [task({ id: "a", status: "in-progress", cellId: "p1" })];

    expect(countTasks(tasks, () => LOTUS_VOCABULARY).active).toBe(1);
  });
});

describe("one answer to \"is this active\"", () => {
  const panes = (entries: Record<string, "working" | "done" | "needs-you">) =>
    new Map(Object.entries(entries).map(([id, activity]) => [id, { activity, since: 0 }]));
  const tasks = [
    task({ id: "live", status: "in-progress", cellId: "p1" }),
    task({ id: "waiting", status: "in-progress", cellId: "p2" }),
    // A binding the recorder never released: the pane is gone, the claim stayed.
    task({ id: "stale", status: "in-progress", cellId: "gone" }),
    task({ id: "finished", status: "in-progress", cellId: "p3" }),
    // Running, but somebody already marked the task done — not work still waiting.
    task({ id: "closed", status: "complete", cellId: "p4" }),
  ];
  const activities = panes({ p1: "working", p2: "needs-you", p3: "done", p4: "working" });

  it("is a pane moving right now, on a task still open", () => {
    const active = tasks.filter((row) => isActiveTask(row, LOTUS_VOCABULARY, activities));
    expect(active.map((row) => row.id)).toEqual(["live", "waiting"]);
  });

  it("is what the Active count counts, so the list and its number never disagree", () => {
    const listed = tasks.filter((row) => isActiveTask(row, LOTUS_VOCABULARY, activities)).length;
    expect(countTasks(tasks, () => LOTUS_VOCABULARY, activities).active).toBe(listed);
  });
});

describe("grouping by project", () => {
  const lotus: TrackerProject = {
    id: "ws-1",
    name: "Workspace 2",
    prefix: "W2",
    vocabulary: LOTUS_VOCABULARY,
  };
  const vault: TrackerProject = {
    id: "vault",
    name: "orbit-vault",
    prefix: "",
    vocabulary: VAULT_VOCABULARY,
  };

  /*
    Two projects with different words in one list. Grouping by status across both would have to
    decide whether Lotus's `blocked` sits above or below the vault's `qa-revision` — two words
    that are never neighbours in any vocabulary. Grouping by project first means the question
    never arises: one project, one vocabulary, always.
  */
  it("gives each project its own sections, in its own words", () => {
    const groups = groupTasksByProject(
      [
        task({ id: "a", projectId: "ws-1", status: "blocked" }),
        task({ id: "b", projectId: "vault", status: "qa-revision" as BridgeTaskStatus }),
        task({ id: "c", projectId: "vault", status: "released" as BridgeTaskStatus }),
      ],
      [lotus, vault],
      "priority",
    );

    expect(
      groups.map((group) => [group.project.id, group.total, group.sections.map((s) => s.label)]),
    ).toEqual([
      ["ws-1", 1, ["Blocked"]],
      ["vault", 2, ["QA Revision", "Released"]],
    ]);
  });

  it("drops a project with nothing left to show", () => {
    const groups = groupTasksByProject(
      [task({ id: "a", projectId: "ws-1", status: "todo" })],
      [lotus, vault],
      "priority",
    );

    expect(groups.map((group) => group.project.id)).toEqual(["ws-1"]);
  });
});

describe("vocabulary", () => {
  /*
    A vocabulary nothing else in the app uses: same three tasks, a different order and different
    words. If grouping still answers in Lotus's words, it is reading the module constant and this
    test is the only thing that would ever say so.
  */
  const FAKE: StatusVocabulary = {
    order: ["complete", "todo", "in-progress"],
    labels: { complete: "Shipped", todo: "Waiting", "in-progress": "Under way" },
    tones: { complete: "done", todo: "open", "in-progress": "progress" },
    open: ["todo"],
  };

  it("groups in the order the given vocabulary sets, with its words", () => {
    const sections = groupTasksByStatus(
      [
        task({ id: "a", status: "in-progress" }),
        task({ id: "b", status: "todo" }),
        task({ id: "c", status: "complete" }),
      ],
      "priority",
      FAKE,
    );

    expect(sections.map((section) => [section.status, section.label])).toEqual([
      ["complete", "Shipped"],
      ["todo", "Waiting"],
      ["in-progress", "Under way"],
    ]);
  });
});

describe("hiding finished work across two vocabularies", () => {
  const vocabularyOf = (task: TrackerTask) =>
    task.projectId === "vault" ? VAULT_VOCABULARY : LOTUS_VOCABULARY;

  it("keeps a ticket whose project still calls its status open", () => {
    const tasks = [
      task({ id: "vault-ready", projectId: "vault", status: "ready-to-prod" as BridgeTaskStatus }),
      task({ id: "vault-shipped", projectId: "vault", status: "released" as BridgeTaskStatus }),
      task({ id: "lotus-done", projectId: "ws-1", status: "complete" }),
    ];

    expect(filterTasks(tasks, { openOnly: true }, { vocabularyOf }).map((t) => t.id)).toEqual([
      "vault-ready",
    ]);
  });
});

describe("counting across two vocabularies", () => {
  // The sidebar badge is one number over every project, and "open" is a different set of words in
  // each. Answering it from one vocabulary is how a released vault ticket would be counted as work
  // still waiting — 37 of them.
  const vocabularyOf = (task: TrackerTask) =>
    task.projectId === "vault" ? VAULT_VOCABULARY : LOTUS_VOCABULARY;

  it("asks each task's own project whether it is still open", () => {
    const tasks = [
      task({ id: "lotus-blocked", projectId: "ws-1", status: "blocked" }),
      task({ id: "lotus-done", projectId: "ws-1", status: "complete" }),
      task({ id: "vault-qa", projectId: "vault", status: "qa-revision" as BridgeTaskStatus }),
      task({ id: "vault-shipped", projectId: "vault", status: "released" as BridgeTaskStatus }),
    ];

    expect(countTasks(tasks, vocabularyOf)).toEqual({ total: 4, open: 2, active: 0 });
  });
});

describe("each task's words, read from its project", () => {
  const lotus: TrackerProject = { id: "ws-1", name: "Lotus", prefix: "LOT", vocabulary: LOTUS_VOCABULARY };
  const vault: TrackerProject = { id: "vault", name: "orbit-vault", prefix: "", vocabulary: VAULT_VOCABULARY, capabilities: VAULT_CAPABILITIES };
  const vocabularyOf = vocabularyByProject(new Map([[lotus.id, lotus], [vault.id, vault]]));

  it("counts a vault ticket by the vault's words, the way the sidebar badge must", () => {
    const tasks = [
      task({ id: "lotus-todo", projectId: "ws-1", status: "todo" }),
      task({ id: "vault-review", projectId: "vault", status: "in-review" }),
      task({ id: "vault-qa", projectId: "vault", status: "qa-revision" as BridgeTaskStatus }),
      task({ id: "vault-backlog", projectId: "vault", status: "backlog" as BridgeTaskStatus }),
      task({ id: "vault-shipped", projectId: "vault", status: "released" as BridgeTaskStatus }),
    ];

    expect(countTasks(tasks, vocabularyOf).open).toBe(4);
  });

  it("falls back to Lotus's words for a project it has not heard of", () => {
    expect(vocabularyOf(task({ id: "orphan", projectId: "gone" }))).toBe(LOTUS_VOCABULARY);
  });
});

describe("blocked", () => {
  // `lotus_update_task` writes this status on a failed review, so it is not a future word — it
  // is written today, and the list has been drawing it at the very bottom under Done.
  it("gives blocked its own section above Todo, with a name and a hue of its own", () => {
    const sections = groupTasksByStatus(
      [
        task({ id: "a", status: "todo" }),
        task({ id: "b", status: "blocked" }),
        task({ id: "c", status: "complete" }),
      ],
      "priority",
      LOTUS_VOCABULARY,
    );

    expect(sections.map((section) => [section.status, section.label, section.tone])).toEqual([
      ["blocked", "Blocked", "blocked"],
      ["todo", "Todo", "open"],
      ["complete", "Done", "done"],
    ]);
  });

  it("counts a blocked task as still someone's problem", () => {
    const tasks = [task({ id: "a", status: "blocked" }), task({ id: "b", status: "complete" })];

    expect(countTasks(tasks, () => LOTUS_VOCABULARY).open).toBe(1);
    expect(filterTasks(tasks, { openOnly: true }).map((t) => t.id)).toEqual(["a"]);
  });
});

describe("sorting", () => {
  it("puts urgency first, and an unset priority last", () => {
    const tasks = [
      task({ id: "none", priority: "none", number: 1 }),
      task({ id: "low", priority: "low", number: 2 }),
      task({ id: "high", priority: "high", number: 3 }),
      task({ id: "medium", priority: "medium", number: 4 }),
    ];
    // "I have not decided" must not outrank "I decided this can wait".
    expect(sortTasks(tasks).map((t) => t.id)).toEqual(["high", "medium", "low", "none"]);
  });

  it("breaks ties the same way every time, so rows do not swap between renders", () => {
    const tasks = [
      task({ id: "b", priority: "high", number: 7 }),
      task({ id: "a", priority: "high", number: 3 }),
    ];
    expect(sortTasks(tasks).map((t) => t.id)).toEqual(["a", "b"]);
    expect(sortTasks([...tasks].reverse()).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("sorts unnumbered tasks after numbered ones rather than before them", () => {
    const tasks = [task({ id: "new" }), task({ id: "old", number: 9 })];
    expect(sortTasks(tasks, "number").map((t) => t.id)).toEqual(["old", "new"]);
  });

  it("sorts most recently touched first when asked", () => {
    const tasks = [
      task({ id: "stale", updatedAt: 1_000 }),
      task({ id: "fresh", updatedAt: 9_000 }),
    ];
    expect(sortTasks(tasks, "recent").map((t) => t.id)).toEqual(["fresh", "stale"]);
  });
});

describe("grouping", () => {
  it("puts work in flight above work that is finished", () => {
    const tasks = [
      task({ id: "done", status: "complete" }),
      task({ id: "open", status: "todo" }),
      task({ id: "running", status: "in-progress" }),
      task({ id: "review", status: "in-review" }),
    ];
    expect(groupTasksByStatus(tasks, "priority", LOTUS_VOCABULARY).map((section) => section.status)).toEqual([
      "in-progress",
      "in-review",
      "todo",
      "complete",
    ]);
  });

  it("draws no empty sections", () => {
    // "Done 0" is chrome that tells you nothing, and a young project would be mostly headings.
    const sections = groupTasksByStatus([task({ id: "a", status: "todo" })], "priority", LOTUS_VOCABULARY);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ status: "todo", label: "Todo", tone: "open" });
  });

  it("sorts inside a section, not across it", () => {
    const tasks = [
      task({ id: "low", status: "todo", priority: "low", number: 1 }),
      task({ id: "high", status: "todo", priority: "high", number: 2 }),
      task({ id: "running", status: "in-progress", priority: "none", number: 3 }),
    ];
    const sections = groupTasksByStatus(tasks, "priority", LOTUS_VOCABULARY);
    expect(sections[0].tasks.map((t) => t.id)).toEqual(["running"]);
    expect(sections[1].tasks.map((t) => t.id)).toEqual(["high", "low"]);
  });

  it("still shows a status this build has never heard of, at the end", () => {
    // The vocabulary can grow in the store or in an MCP tool without a desktop release; dropping
    // those tasks would hide work rather than show it late.
    //
    // This used to reach for `blocked` as its example of a word nobody had taught the build —
    // while `lotus_record_review_verdict` was already writing exactly that on every FAIL. The
    // mechanism was right and the example was a bug wearing a test's clothes, so the example is
    // now a word the store really cannot produce.
    const tasks = [
      task({ id: "known", status: "todo" }),
      task({ id: "future", status: "archived" as BridgeTaskStatus }),
    ];
    const sections = groupTasksByStatus(tasks, "priority", LOTUS_VOCABULARY);
    expect(sections.map((section) => section.status)).toEqual(["todo", "archived"]);
    expect(sections[1].label).toBe("archived");
  });
});

describe("counting", () => {
  it("separates what exists, what is open, and what is running right now", () => {
    const tasks = [
      task({ id: "a", status: "in-progress", cellId: "pane-1" }),
      task({ id: "b", status: "todo" }),
      task({ id: "c", status: "complete" }),
    ];
    expect(countTasks(tasks, () => LOTUS_VOCABULARY)).toEqual({ total: 3, open: 2, active: 1 });
  });

  it("does not call a finished task active just because it remembers where it ran", () => {
    const tasks = [task({ id: "a", status: "complete", cellId: "pane-1" })];
    expect(countTasks(tasks, () => LOTUS_VOCABULARY)).toEqual({ total: 1, open: 0, active: 0 });
  });
});

describe("the order somebody chose", () => {
  it("sorts by the place each row was given, and a row never moved sits where its number puts it", () => {
    const tasks = [
      task({ id: "third-made", number: 3 }),
      task({ id: "first-made", number: 1 }),
      task({ id: "dragged-to-top", number: 5, position: 0.5 }),
      task({ id: "second-made", number: 2 }),
    ];

    expect(sortTasks(tasks, "manual").map((row) => row.id)).toEqual([
      "dragged-to-top",
      "first-made",
      "second-made",
      "third-made",
    ]);
  });
});

describe("moving a row", () => {
  // A section as drawn, top to bottom.
  const section = [
    task({ id: "a", number: 1 }),
    task({ id: "b", number: 2 }),
    task({ id: "c", number: 3 }),
  ];

  it("dropped between two rows takes the midpoint, and nothing else is rewritten", () => {
    // `c` moved up one: it now sits between `a` (1) and `b` (2).
    expect(reorderWrites(section, "c", 1)).toEqual([{ id: "c", position: 1.5 }]);
  });

  it("moved to the top goes one above the first row", () => {
    expect(reorderWrites(section, "c", 0)).toEqual([{ id: "c", position: 0 }]);
  });

  it("moved to the bottom goes one below the last row", () => {
    expect(reorderWrites(section, "a", 2)).toEqual([{ id: "a", position: 4 }]);
  });

  it("dropped where it already was writes nothing", () => {
    expect(reorderWrites(section, "b", 1)).toEqual([]);
  });

  it("renumbers the section when the gap between two neighbours has worn too thin to split", () => {
    const worn = [
      task({ id: "a", position: 1 }),
      task({ id: "b", position: 1 + 1e-10 }),
      task({ id: "c", position: 3 }),
    ];

    // `c` between `a` and `b`: no room left, so the whole section is laid out again, 1, 2, 3.
    // `a` is already at 1 and is not rewritten; the rest follow in their new order.
    expect(reorderWrites(worn, "c", 1)).toEqual([
      { id: "c", position: 2 },
      { id: "b", position: 3 },
    ]);
  });
});
