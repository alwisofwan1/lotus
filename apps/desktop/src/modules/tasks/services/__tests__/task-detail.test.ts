import { describe, expect, it } from "vitest";
import {
  blockerLine,
  formatTaskEventAge,
  intakeLine,
  listPosition,
  stripRepeatedTitle,
  subTaskProgress,
  taskActivityRows,
  taskHasRecord,
} from "@/modules/tasks/services/task-detail";
import type { BridgeTaskFeedbackEvent } from "@/modules/codespace/services/bridge/task-store";

const event = (
  id: string,
  at: number,
  kind: BridgeTaskFeedbackEvent["kind"],
  actor: BridgeTaskFeedbackEvent["actor"],
  summary = "",
): BridgeTaskFeedbackEvent => ({ id, at, kind, actor, summary });

describe("taskActivityRows", () => {
  it("tells the story in the order it happened", () => {
    const rows = taskActivityRows([
      event("c", 300, "review-verdict", "reviewer", "Looks right"),
      event("a", 100, "intake-created", "director"),
      event("b", 200, "agent-result", "agent", "Fixed the selector"),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("says who did what, not which function ran", () => {
    const [row] = taskActivityRows([event("a", 1, "assignment-dispatched", "director")]);
    expect(row.actor).toBe("Director");
    expect(row.action).toBe("handed it to an agent");
  });

  it("prints a kind this build has never heard of rather than dropping the entry", () => {
    const rows = taskActivityRows([
      { id: "x", at: 1, actor: "ghost", kind: "teleported", summary: "" } as never,
    ]);
    expect(rows[0]).toMatchObject({ actor: "ghost", action: "teleported" });
  });

  it("has nothing to say about a task with no history", () => {
    expect(taskActivityRows(undefined)).toEqual([]);
  });
});

describe("formatTaskEventAge", () => {
  it("says just now rather than hiding the newest line", () => {
    expect(formatTaskEventAge(10_000)).toBe("just now");
  });

  it("climbs through the coarsest honest unit", () => {
    expect(formatTaskEventAge(5 * 60_000)).toBe("5m ago");
    expect(formatTaskEventAge(3 * 3_600_000)).toBe("3h ago");
    expect(formatTaskEventAge(2 * 86_400_000)).toBe("2d ago");
    expect(formatTaskEventAge(60 * 86_400_000)).toBe("2mo ago");
  });

  it("switches to whole years from 12 months on", () => {
    const month = 30 * 86_400_000;
    expect(formatTaskEventAge(11 * month)).toBe("11mo ago");
    expect(formatTaskEventAge(365 * 86_400_000)).toBe("1y ago");
    expect(formatTaskEventAge(14 * month)).toBe("1y ago");
    expect(formatTaskEventAge(25 * month)).toBe("2y ago");
  });
});

describe("blockerLine", () => {
  it("says what stopped, where, and why", () => {
    expect(
      blockerLine({ phase: "execution", type: "auth", reason: "claude is not signed in" }),
    ).toBe("not signed in while doing the work — claude is not signed in");
  });

  it("drops the dash when nobody wrote a reason", () => {
    expect(blockerLine({ phase: "review", type: "ambiguity", reason: "  " })).toBe(
      "unclear while reviewing",
    );
  });

  it("says nothing when nothing is blocked", () => {
    expect(blockerLine(undefined)).toBeNull();
  });
});

describe("intakeLine", () => {
  it("prints the confidence, because the decision alone reads as certainty", () => {
    expect(intakeLine({ briefXml: "", confidence: 0.42, decision: "assign", updatedAt: 1 })).toBe(
      "Assign to an agent · 42% confident",
    );
  });

  it("keeps a confidence outside 0–1 from printing nonsense", () => {
    expect(intakeLine({ briefXml: "", confidence: 4, decision: "ask-human", updatedAt: 1 })).toBe(
      "Ask you first · 100% confident",
    );
  });
});

describe("subTaskProgress", () => {
  /*
    `completed`, not `done`. Rust serialises `SubTaskStatus::Completed` as `"completed"`
    (`bridge_tasks.rs`), and this counter looked for a word the store cannot produce — so the
    header read "0/3 sub-tasks" however many were finished. This test asked for `"done"` too, so
    it agreed with the bug rather than catching it.
  */
  it("counts what the store calls completed", () => {
    expect(
      subTaskProgress([
        { id: "1", title: "a", status: "completed" },
        { id: "2", title: "b", status: "pending" },
        { id: "3", title: "c", status: "in-progress" },
      ]),
    ).toEqual({ done: 1, total: 3 });
  });

  it("returns nothing when there was never a checklist", () => {
    expect(subTaskProgress([])).toBeNull();
    expect(subTaskProgress(undefined)).toBeNull();
  });
});

describe("taskHasRecord", () => {
  it("tells a task nobody has touched from one whose history is empty", () => {
    expect(taskHasRecord({})).toBe(false);
    expect(taskHasRecord({ feedbackEvents: [event("a", 1, "agent-result", "agent")] })).toBe(true);
  });
});

describe("the description under the title", () => {
  it("drops a leading heading that only repeats the title", () => {
    expect(stripRepeatedTitle("# Ship it\n\nBody", "Ship it")).toBe("Body");
  });

  it("matches the title loosely — case, spacing and trailing punctuation", () => {
    expect(stripRepeatedTitle("##  ship   IT.\nBody", "Ship it")).toBe("Body");
  });

  it("keeps a first heading that says something else", () => {
    expect(stripRepeatedTitle("# Context\n\nBody", "Ship it")).toBe("# Context\n\nBody");
  });

  it("leaves nothing when the description only repeats the title — the panel then says no brief was written", () => {
    expect(stripRepeatedTitle("Ship it", "Ship it")).toBe("");
  });
});

describe("stepping through the list from a task", () => {
  const ids = ["a", "b", "c"];

  it("says where the open task sits, counting from one", () => {
    expect(listPosition(ids, "b")).toEqual({ index: 2, total: 3, prev: "a", next: "c" });
  });

  it("has nowhere to go past either end", () => {
    expect(listPosition(ids, "a")).toMatchObject({ prev: null, next: "b" });
    expect(listPosition(ids, "c")).toMatchObject({ prev: "b", next: null });
  });

  it("claims no position for a task the filters have hidden", () => {
    expect(listPosition(ids, "z")).toBeNull();
  });
});
