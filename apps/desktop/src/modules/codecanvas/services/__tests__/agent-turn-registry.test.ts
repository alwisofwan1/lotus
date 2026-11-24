import { describe, expect, it, vi } from "vitest";
import { createAgentTurnRegistry } from "../agent-turn-registry";

describe("agentTurnRegistry", () => {
  it("reads back a recorded fact by pane id", () => {
    const registry = createAgentTurnRegistry();

    registry.record({ paneId: "canvas:cp_1:node-a", turn: "needs-input", atMs: 1_000 });

    expect(registry.get("canvas:cp_1:node-a")).toEqual({
      paneId: "canvas:cp_1:node-a",
      turn: "needs-input",
      atMs: 1_000,
    });
  });

  it("keeps the newer fact when an older one arrives late", () => {
    // The cold hydrate (`canvasPaneTurns`) races the push stream (`mcp://pane-turn`): a board
    // that mounts while an agent is mid-turn can have the hydrate resolve AFTER a pushed fact.
    // Last-write-wins would then replace `needs-input` with a stale `running` and the badge would
    // silently regress — the exact class of lie this plan exists to remove.
    const registry = createAgentTurnRegistry();

    registry.record({ paneId: "p-1", turn: "needs-input", atMs: 2_000 });
    registry.record({ paneId: "p-1", turn: "running", atMs: 1_000 });

    expect(registry.get("p-1")?.turn).toBe("needs-input");
  });

  it("accepts a newer fact for a pane it already knows", () => {
    const registry = createAgentTurnRegistry();

    registry.record({ paneId: "p-1", turn: "running", atMs: 1_000 });
    registry.record({ paneId: "p-1", turn: "idle", atMs: 2_000 });

    expect(registry.get("p-1")?.turn).toBe("idle");
  });

  it("accepts a same-timestamp fact, because two hooks can share a millisecond", () => {
    // Ties go to the newcomer: `tool-post` and `stop` can land in the same millisecond, and the
    // later arrival is the later event. Rejecting ties would freeze a pane on the first of them.
    const registry = createAgentTurnRegistry();

    registry.record({ paneId: "p-1", turn: "running", atMs: 5_000 });
    registry.record({ paneId: "p-1", turn: "idle", atMs: 5_000 });

    expect(registry.get("p-1")?.turn).toBe("idle");
  });

  it("notifies subscribers when a fact lands", () => {
    const registry = createAgentTurnRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);

    registry.record({ paneId: "p-1", turn: "running", atMs: 1_000 });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stays silent when a stale fact is rejected", () => {
    // Nothing observable changed, so nothing downstream should re-render. Notifying here would
    // make every late hydrate re-render the whole board for no reason.
    const registry = createAgentTurnRegistry();
    registry.record({ paneId: "p-1", turn: "needs-input", atMs: 2_000 });
    const listener = vi.fn();
    registry.subscribe(listener);

    registry.record({ paneId: "p-1", turn: "running", atMs: 1_000 });

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying after unsubscribe", () => {
    const registry = createAgentTurnRegistry();
    const listener = vi.fn();
    const off = registry.subscribe(listener);

    off();
    registry.record({ paneId: "p-1", turn: "running", atMs: 1_000 });

    expect(listener).not.toHaveBeenCalled();
  });

  it("forgets a pane on clear and says so", () => {
    const registry = createAgentTurnRegistry();
    registry.record({ paneId: "p-1", turn: "needs-input", atMs: 1_000 });
    const listener = vi.fn();
    registry.subscribe(listener);

    registry.clear("p-1");

    expect(registry.get("p-1")).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stays silent when clearing a pane it never knew", () => {
    const registry = createAgentTurnRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);

    registry.clear("never-seen");

    expect(listener).not.toHaveBeenCalled();
  });

  it("lets a pane start over after its node is closed and reopened", () => {
    // `clear` runs on node unmount. A reopened node gets a fresh pane id in the usual case, but a
    // persisted pane keeps its id — and its first new fact will carry an EARLIER timestamp than
    // the cleared one if the clock is compared naively. Clearing must drop the watermark too,
    // otherwise a reopened pane can never record anything again.
    const registry = createAgentTurnRegistry();
    registry.record({ paneId: "p-1", turn: "idle", atMs: 9_000 });

    registry.clear("p-1");
    registry.record({ paneId: "p-1", turn: "running", atMs: 1_000 });

    expect(registry.get("p-1")?.turn).toBe("running");
  });

  it("exposes a version that advances only when something observably changed", () => {
    // `useSyncExternalStore` needs a primitive, reference-stable snapshot. A counter is that, and
    // gating it on real change is what keeps a rejected stale fact from repainting the board.
    const registry = createAgentTurnRegistry();
    const start = registry.version();

    registry.record({ paneId: "p-1", turn: "needs-input", atMs: 2_000 });
    const afterWrite = registry.version();
    registry.record({ paneId: "p-1", turn: "running", atMs: 1_000 }); // stale, rejected

    expect(afterWrite).toBeGreaterThan(start);
    expect(registry.version()).toBe(afterWrite);
  });

  it("advances the version on a clear that removed something", () => {
    const registry = createAgentTurnRegistry();
    registry.record({ paneId: "p-1", turn: "idle", atMs: 1 });
    const before = registry.version();

    registry.clear("p-1");
    const afterClear = registry.version();
    registry.clear("never-seen");

    expect(afterClear).toBeGreaterThan(before);
    expect(registry.version()).toBe(afterClear);
  });

  it("records that a human answered a pane, and reads it back", () => {
    const registry = createAgentTurnRegistry();

    registry.noteAnswered("p-1", 5_000);

    expect(registry.answeredAt("p-1")).toBe(5_000);
    expect(registry.answeredAt("p-2")).toBeUndefined();
  });

  it("keeps the latest answer when a human acts twice", () => {
    const registry = createAgentTurnRegistry();

    registry.noteAnswered("p-1", 5_000);
    registry.noteAnswered("p-1", 9_000);
    registry.noteAnswered("p-1", 7_000); // out of order

    expect(registry.answeredAt("p-1")).toBe(9_000);
  });

  it("notifies subscribers, because a badge depends on it", () => {
    const registry = createAgentTurnRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);

    registry.noteAnswered("p-1", 1_000);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the answer is not newer than the one on record", () => {
    const registry = createAgentTurnRegistry();
    registry.noteAnswered("p-1", 5_000);
    const listener = vi.fn();
    registry.subscribe(listener);

    registry.noteAnswered("p-1", 4_000);

    expect(listener).not.toHaveBeenCalled();
  });

  it("forgets the answer when the pane is cleared", () => {
    // `clear` runs on node unmount. Leaving the mark behind would suppress the first genuine ask a
    // reopened pane raises.
    const registry = createAgentTurnRegistry();
    registry.noteAnswered("p-1", 5_000);

    registry.clear("p-1");

    expect(registry.answeredAt("p-1")).toBeUndefined();
  });
});
