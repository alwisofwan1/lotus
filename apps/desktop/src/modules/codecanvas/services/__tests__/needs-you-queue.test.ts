import { describe, expect, it } from "vitest";
import { formatWaiting, mergeNeedsYou, needsYouQueue, nextNeedsYouTarget } from "../needs-you-queue";
import type { AgentStatusSnapshot } from "../agent-status-registry";
import type { AgentTurnFact } from "../agent-turn-registry";

const NOW = 1_000_000;

function agent(id: string, name: string, status: AgentStatusSnapshot["status"]): AgentStatusSnapshot {
  return { id, name, status, hookPaneId: `canvas:cp_1:${id}` };
}

/** A fact lookup keyed the way the registry is — by the pane's LOTUS_PANE_ID. */
function facts(entries: Record<string, number>) {
  return (paneId: string): AgentTurnFact | undefined => {
    const atMs = entries[paneId];
    return atMs === undefined ? undefined : { paneId, turn: "needs-input", atMs };
  };
}

describe("needsYouQueue", () => {
  it("lists only the agents that need a human", () => {
    const roster = [
      agent("n1", "Atlas", "needs-you"),
      agent("n2", "Nara", "running"),
      agent("n3", "Ilya", "idle"),
      agent("n4", "Kai", "error"),
    ];

    const queue = needsYouQueue(roster, facts({ "canvas:cp_1:n1": NOW - 5_000 }), NOW);

    expect(queue.map((e) => e.name)).toEqual(["Atlas"]);
  });

  it("puts the longest-waiting ask first", () => {
    const roster = [agent("n1", "Atlas", "needs-you"), agent("n2", "Mira", "needs-you")];

    const queue = needsYouQueue(
      roster,
      facts({ "canvas:cp_1:n1": NOW - 14_000, "canvas:cp_1:n2": NOW - 120_000 }),
      NOW,
    );

    expect(queue.map((e) => e.name)).toEqual(["Mira", "Atlas"]);
  });

  it("does not move an existing row when a newer ask arrives", () => {
    // The property the whole design rests on. A row that shifts under the cursor at the moment the
    // operator reaches for it is worse than no lane at all — and because the sort key is the ask's
    // own timestamp, which never changes, a newcomer can only ever append.
    const before = needsYouQueue(
      [agent("n1", "Atlas", "needs-you"), agent("n2", "Mira", "needs-you")],
      facts({ "canvas:cp_1:n1": NOW - 90_000, "canvas:cp_1:n2": NOW - 40_000 }),
      NOW,
    );

    const later = NOW + 5_000;
    const after = needsYouQueue(
      [agent("n1", "Atlas", "needs-you"), agent("n2", "Mira", "needs-you"), agent("n3", "Kai", "needs-you")],
      facts({
        "canvas:cp_1:n1": NOW - 90_000,
        "canvas:cp_1:n2": NOW - 40_000,
        "canvas:cp_1:n3": later - 200,
      }),
      later,
    );

    expect(before.map((e) => e.name)).toEqual(["Atlas", "Mira"]);
    expect(after.map((e) => e.name)).toEqual(["Atlas", "Mira", "Kai"]);
  });

  it("keeps the survivors in order when one ask is answered", () => {
    const roster = [agent("n1", "Atlas", "needs-you"), agent("n3", "Kai", "needs-you")];

    const queue = needsYouQueue(
      roster,
      facts({ "canvas:cp_1:n1": NOW - 90_000, "canvas:cp_1:n3": NOW - 200 }),
      NOW,
    );

    expect(queue.map((e) => e.name)).toEqual(["Atlas", "Kai"]);
  });

  it("reports how long each ask has been waiting", () => {
    const queue = needsYouQueue(
      [agent("n1", "Atlas", "needs-you")],
      facts({ "canvas:cp_1:n1": NOW - 8_000 }),
      NOW,
    );

    expect(queue[0].waitingMs).toBe(8_000);
  });

  it("never reports a negative wait when a hook clock runs ahead", () => {
    // The timestamp comes from another process. A negative age would render as "-3s waiting".
    const queue = needsYouQueue(
      [agent("n1", "Atlas", "needs-you")],
      facts({ "canvas:cp_1:n1": NOW + 3_000 }),
      NOW,
    );

    expect(queue[0].waitingMs).toBe(0);
  });

  it("sorts an ask with no backing fact last rather than treating it as the oldest", () => {
    // `needs-you` is only ever produced BY a fact, so a missing one means the status registry and
    // the turn registry are momentarily out of step. Ranking it first would promote an absence.
    const queue = needsYouQueue(
      [agent("n1", "Atlas", "needs-you"), agent("n2", "Mira", "needs-you")],
      facts({ "canvas:cp_1:n2": NOW - 1_000 }),
      NOW,
    );

    expect(queue.map((e) => e.name)).toEqual(["Mira", "Atlas"]);
    expect(queue[1].waitingMs).toBeUndefined();
  });

  it("carries the node id and pane id so a row can focus and be read", () => {
    const queue = needsYouQueue(
      [agent("n1", "Atlas", "needs-you")],
      facts({ "canvas:cp_1:n1": NOW }),
      NOW,
    );

    expect(queue[0]).toMatchObject({ id: "n1", paneId: "canvas:cp_1:n1", name: "Atlas" });
  });

  it("is empty when nothing needs a human", () => {
    const queue = needsYouQueue([agent("n1", "Atlas", "running")], facts({}), NOW);

    expect(queue).toEqual([]);
  });
});

describe("formatWaiting", () => {
  it("reads in seconds under a minute", () => {
    expect(formatWaiting(0)).toBe("0s");
    expect(formatWaiting(14_400)).toBe("14s");
    expect(formatWaiting(59_900)).toBe("59s");
  });

  it("reads in whole minutes up to an hour", () => {
    expect(formatWaiting(60_000)).toBe("1m");
    expect(formatWaiting(120_000)).toBe("2m");
    expect(formatWaiting(3_540_000)).toBe("59m");
  });

  it("reads in hours beyond that, because a prompt can wait all afternoon", () => {
    // TURN_FRESH_MS is 4h, so "4h" is a value the lane can genuinely show — and an ask that old is
    // exactly the one worth making legible rather than rounding to "59m".
    expect(formatWaiting(3_600_000)).toBe("1h");
    expect(formatWaiting(14_400_000)).toBe("4h");
  });

  it("says nothing when the wait is unknown", () => {
    // Rendering "0s" for a missing fact would claim the ask just arrived.
    expect(formatWaiting(undefined)).toBe("");
  });
});

describe("nextNeedsYouTarget", () => {
  const queue = (...names: string[]) =>
    names.map((name, i) => ({
      id: `n${i + 1}`,
      paneId: `canvas:cp_1:n${i + 1}`,
      name,
      waitingMs: (names.length - i) * 10_000,
    }));

  it("goes to the longest-waiting ask when nothing relevant is focused", () => {
    expect(nextNeedsYouTarget(queue("Atlas", "Mira"), null)).toBe("n1");
  });

  it("walks to the next ask when the current one is already focused", () => {
    // Otherwise the chord is a no-op the second time you press it, and a queue of three asks needs
    // three different gestures to work through.
    expect(nextNeedsYouTarget(queue("Atlas", "Mira", "Kai"), "n1")).toBe("n2");
    expect(nextNeedsYouTarget(queue("Atlas", "Mira", "Kai"), "n2")).toBe("n3");
  });

  it("wraps from the last back to the first", () => {
    expect(nextNeedsYouTarget(queue("Atlas", "Mira"), "n2")).toBe("n1");
  });

  it("starts at the oldest when the focused node is not waiting at all", () => {
    // Focus normally sits on whatever the operator was last doing, which is usually not in the queue.
    expect(nextNeedsYouTarget(queue("Atlas", "Mira"), "some-terminal")).toBe("n1");
  });

  it("re-focuses the only ask rather than doing nothing", () => {
    // A single-entry queue must still bring the camera back to it — pressing the chord and having
    // the view not move reads as a broken shortcut.
    expect(nextNeedsYouTarget(queue("Atlas"), "n1")).toBe("n1");
  });

  it("does nothing when nothing needs a human", () => {
    expect(nextNeedsYouTarget([], null)).toBeNull();
    expect(nextNeedsYouTarget([], "n1")).toBeNull();
  });
});

describe("mergeNeedsYou (S5)", () => {
  it("places the Dock apps' asks among the agents by the same oldest-first key", () => {
    const agent = { id: "n1", paneId: "p1", name: "Rex", waitingMs: 60_000 };
    const quiet = { id: "n2", paneId: "p2", name: "Ivy", waitingMs: undefined };
    const run = { id: "factory:r1", source: "factory" as const, name: "#42 Fix", line: "Answer 2 questions", askedAtMs: 0, onOpen: () => {} };
    const merged = mergeNeedsYou([agent, quiet], [run], 3_600_000);
    expect(merged.map((e) => e.id)).toEqual(["factory:r1", "n1", "n2"]);
    expect(merged[0]).toMatchObject({ source: "factory", headline: "Answer 2 questions", waitingMs: 3_600_000 });
  });
});
