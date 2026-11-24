import { describe, expect, it } from "vitest";
import { taskDraftFromTicket, taskToReuseForTicket, tasksFromTicket } from "@/modules/tasks/services/ticket-to-task";
import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import type { TrackerTask } from "@/modules/tasks/types";
import { TASK_GOAL_CAP, TASK_TITLE_CAP } from "@/modules/tasks/services/task-draft";
import type { VaultTicketDetail } from "@/modules/tasks/services/vault-api";

const detail = (overrides: Partial<VaultTicketDetail> = {}): VaultTicketDetail => ({
  ticket: {
    file: "TKT-987.md",
    ticket: "TKT-987",
    title: "Regional Pricing and Region-Only Plans",
    status: "in-review",
    tags: [],
    modifiedAt: 0,
  },
  sections: [
    { heading: undefined, body: "Two related rules, both driven by the organization's country." },
    { heading: "Plan", body: "Gate the purchase, never the runtime." },
  ],
  revision: "r1",
  ...overrides,
});

describe("a vault ticket as a task worth delegating", () => {
  it("keeps the key in the title, because that is what the work is called", () => {
    expect(taskDraftFromTicket(detail()).title).toBe(
      "TKT-987 — Regional Pricing and Region-Only Plans",
    );
  });

  it("points back at the file it came from", () => {
    // The key alone is not enough to reopen it: two files in the real vault share `ticket: DRAFT`.
    expect(taskDraftFromTicket(detail()).source).toEqual({
      kind: "vault",
      ref: "TKT-987.md",
      label: "TKT-987",
    });
  });

  it("takes the goal from what the ticket opens with", () => {
    expect(taskDraftFromTicket(detail()).goal).toBe(
      "Two related rules, both driven by the organization's country.",
    );
  });

  /*
    The store caps a goal at 500 characters and TKT-987's Notion paste alone is 15 KB. The cap is
    not a suggestion — `validate_create` refuses a longer one — so the prose has to be cut here,
    visibly, rather than at the wire where the write would simply fail.
  */
  it("cuts a goal the store would refuse, and says it cut it", () => {
    const long = detail({ sections: [{ heading: undefined, body: "x".repeat(2_000) }] });

    const goal = taskDraftFromTicket(long).goal;

    expect(goal.length).toBeLessThanOrEqual(TASK_GOAL_CAP);
    expect(goal).toContain("…");
  });

  it("cuts a title the store would refuse", () => {
    const long = detail({ ticket: { ...detail().ticket, title: "y".repeat(400) } });

    expect(taskDraftFromTicket(long).title.length).toBeLessThanOrEqual(TASK_TITLE_CAP);
  });

  it("carries the whole ticket as knowledge, headings and all", () => {
    // The goal is cut to fit; the worker still gets everything the ticket said.
    const knowledge = taskDraftFromTicket(detail()).knowledge;

    expect(knowledge).toContain("Two related rules");
    expect(knowledge).toContain("## Plan");
    expect(knowledge).toContain("Gate the purchase");
  });

  it("survives a ticket with nothing written in it yet", () => {
    const empty = detail({ sections: [] });

    expect(taskDraftFromTicket(empty).goal.length).toBeGreaterThan(0);
  });
});

describe("the tasks a ticket has already become", () => {
  const made = (overrides: Partial<TrackerTask> & { id: string }): TrackerTask => ({
    projectId: "ws-1",
    title: "TKT-987 — work",
    status: "in-progress",
    priority: "none",
    createdAt: 1,
    updatedAt: 1,
    sourceRef: "TKT-987.md",
    ...overrides,
  });
  const tasks = [
    made({ id: "open-here" }),
    made({ id: "done-here", status: "complete" }),
    made({ id: "open-elsewhere", projectId: "ws-2" }),
    made({ id: "other-ticket", sourceRef: "TKT-1.md" }),
    made({ id: "typed-by-hand", sourceRef: undefined }),
  ];

  it("are the tasks made from this file, in any workspace, finished or not", () => {
    expect(tasksFromTicket(tasks, "TKT-987.md").map((task) => task.id)).toEqual([
      "open-here",
      "done-here",
      "open-elsewhere",
    ]);
  });

  it("a second Delegate reuses the one still open in that workspace, rather than making another", () => {
    expect(taskToReuseForTicket(tasks, "TKT-987.md", "ws-1", () => LOTUS_VOCABULARY)?.id).toBe("open-here");
  });

  it("makes a new one when that workspace only has finished work from the ticket", () => {
    const finishedOnly = tasks.filter((task) => task.id !== "open-here");
    expect(taskToReuseForTicket(finishedOnly, "TKT-987.md", "ws-1", () => LOTUS_VOCABULARY)).toBeNull();
  });
});

describe("fitting the store's caps, which count bytes", () => {
  // `validate_text` in `bridge_tasks.rs` measures `.len()` — UTF-8 bytes. The em dash this title is
  // joined with, and the ellipsis it is cut with, are three bytes each.
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");

  it("cuts a real ticket's title to 120 BYTES — TKT-704 came out at 126 and the store refused it", () => {
    const tkt704 = detail({
      ticket: {
        file: "TKT-704.md",
        ticket: "TKT-704",
        title:
          "[Bug] Dunning recovery never collects the failed payment — suspended orgs stay suspended after updating their card",
        status: "in-progress",
        tags: [],
        modifiedAt: 0,
      },
    });

    const { title } = taskDraftFromTicket(tkt704);

    expect(bytes(title)).toBeLessThanOrEqual(TASK_TITLE_CAP);
    expect(title.endsWith("…")).toBe(true);
    expect(title.startsWith("TKT-704 — [Bug] Dunning recovery")).toBe(true);
  });

  it("cuts the goal to 500 bytes, never through the middle of a character", () => {
    const prose = "Pembayaran gagal — kartu “baru” sudah dipasang. ".repeat(20);
    const long = detail({ sections: [{ body: prose }] });

    const { goal } = taskDraftFromTicket(long);

    expect(bytes(goal)).toBeLessThanOrEqual(TASK_GOAL_CAP);
    expect(goal).not.toContain("�");
    expect(goal.endsWith("…")).toBe(true);
  });
});
