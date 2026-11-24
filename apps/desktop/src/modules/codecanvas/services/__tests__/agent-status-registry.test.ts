import { describe, it, expect, vi } from "vitest";
import { createAgentStatusRegistry } from "../agent-status-registry";

describe("agent status registry", () => {
  it("lists the latest published snapshot per node", () => {
    const reg = createAgentStatusRegistry();
    reg.publish({ id: "a", name: "FE", status: "running" });
    reg.publish({ id: "a", name: "FE", status: "completed" });
    // `toMatchObject`, not `toEqual`: the registry now also stamps `statusChangedAt`, and what this
    // test is about is that the later publish won.
    expect(reg.list()).toHaveLength(1);
    expect(reg.list()[0]).toMatchObject({ id: "a", name: "FE", status: "completed" });
  });

  it("drops a node on remove", () => {
    const reg = createAgentStatusRegistry();
    reg.publish({ id: "a", name: "FE", status: "idle" });
    reg.remove("a");
    expect(reg.list()).toEqual([]);
  });

  it("notifies subscribers on publish and remove", () => {
    const reg = createAgentStatusRegistry();
    const cb = vi.fn();
    reg.subscribe(cb);
    reg.publish({ id: "a", name: "FE", status: "running" });
    reg.remove("a");
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

describe("statusChangedAt — how long it has been like this", () => {
  // A resting fleet is most of a fleet most of the time, and at rest every row said the same one or
  // two words. The missing information was never the vocabulary; it was the duration, and nothing
  // recorded it — the snapshot carried no timestamp at all.
  //
  // Stamped here rather than derived from the hook pipeline on purpose: the turn registry and the
  // narration facts both have timings, but only for hook-capable runners. This works for Codex,
  // cursor and custom too, which are exactly the runners the fleet rail was extended to cover.

  it("stamps when a status first appears", () => {
    const registry = createAgentStatusRegistry(() => 1_000);

    registry.publish({ id: "a1", name: "Atlas", status: "running" });

    expect(registry.list()[0].statusChangedAt).toBe(1_000);
  });

  it("re-stamps when the status actually changes", () => {
    let now = 1_000;
    const registry = createAgentStatusRegistry(() => now);
    registry.publish({ id: "a1", name: "Atlas", status: "running" });

    now = 5_000;
    registry.publish({ id: "a1", name: "Atlas", status: "idle" });

    expect(registry.list()[0].statusChangedAt).toBe(5_000);
  });

  it("keeps the original stamp while the status is unchanged", () => {
    // The load-bearing case. Nodes re-publish on every render-ish change — name, session id, runner
    // label. Re-stamping on those would reset the clock constantly and the number would never grow
    // past a few seconds, which is exactly the uninformative row we started from.
    let now = 1_000;
    const registry = createAgentStatusRegistry(() => now);
    registry.publish({ id: "a1", name: "Atlas", status: "idle" });

    now = 9_000;
    registry.publish({ id: "a1", name: "Atlas", status: "idle", sessionId: "s-1" });

    expect(registry.list()[0].statusChangedAt).toBe(1_000);
  });

  it("starts a fresh clock for a pane that was removed and came back", () => {
    let now = 1_000;
    const registry = createAgentStatusRegistry(() => now);
    registry.publish({ id: "a1", name: "Atlas", status: "idle" });
    registry.remove("a1");

    now = 9_000;
    registry.publish({ id: "a1", name: "Atlas", status: "idle" });

    expect(registry.list()[0].statusChangedAt).toBe(9_000);
  });

  it("lets a caller pass its own stamp through untouched", () => {
    // Pocket and the fleet push both hand over snapshots they did not observe first-hand.
    const registry = createAgentStatusRegistry(() => 1_000);

    registry.publish({ id: "a1", name: "Atlas", status: "idle", statusChangedAt: 42 });

    expect(registry.list()[0].statusChangedAt).toBe(42);
  });
});

