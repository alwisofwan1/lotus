import { describe, it, expect } from "vitest";
import { CanvasFleetPushScheduler, type FleetPushSchedulerDeps } from "../canvas-fleet-push-scheduler";
import type { CanvasFleetContext } from "../canvas-fleet";
import type { AgentStatusSnapshot } from "../agent-status-registry";

const ctx: CanvasFleetContext = { projectId: "p1", cwd: "/repo" };
const snap: AgentStatusSnapshot = { id: "n1", name: "Kai", status: "running" };

/** Deterministic timer harness — no real clock, no React. Fire timers explicitly. */
function harness(overrides: Partial<FleetPushSchedulerDeps> = {}) {
  const pushes: { list: AgentStatusSnapshot[]; ctx: CanvasFleetContext }[] = [];
  const timers = new Map<number, () => void>();
  let seq = 0;
  const deps: FleetPushSchedulerDeps = {
    push: (list, c) => pushes.push({ list, ctx: c }),
    setTimer: (fn) => {
      const id = ++seq;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    debounceMs: 200,
    // Constant by default: most tests here are about timers, not about payload freshness. The
    // tests that care override it.
    payloadRevision: () => 0,
    clearGraceMs: 1500,
    ...overrides,
  };
  const runAll = () => {
    for (const [id, fn] of [...timers]) {
      timers.delete(id);
      fn();
    }
  };
  return { pushes, timers, deps, runAll };
}

describe("CanvasFleetPushScheduler", () => {
  it("debounces snapshot pushes and emits the latest once the timer fires", () => {
    const h = harness();
    const s = new CanvasFleetPushScheduler(h.deps);
    s.handleSnapshot([snap], ctx);
    expect(h.pushes).toHaveLength(0); // still debounced
    h.runAll();
    expect(h.pushes).toEqual([{ list: [snap], ctx }]);
  });

  it("does NOT clear the fleet when a remount cancels the deferred clear (F3: StrictMode/route/HMR)", () => {
    const h = harness();
    const s = new CanvasFleetPushScheduler(h.deps);
    s.handleUnmount(ctx); // schedule deferred clear
    s.handleMount(); // remount within the grace window cancels it
    h.runAll();
    expect(h.pushes).toHaveLength(0); // fleet was never blanked
  });

  it("clears the fleet on a genuine teardown (no remount within the grace window)", () => {
    const h = harness();
    const s = new CanvasFleetPushScheduler(h.deps);
    s.handleUnmount(ctx);
    h.runAll();
    expect(h.pushes).toEqual([{ list: [], ctx }]);
  });

  it("forcePush emits immediately (bypassing debounce) and cancels a pending debounced push (F4)", () => {
    const h = harness();
    const s = new CanvasFleetPushScheduler(h.deps);
    s.handleSnapshot([snap], ctx); // pending debounced push
    s.forcePush([snap], ctx); // immediate re-push in response to Rust's refresh request
    expect(h.pushes).toEqual([{ list: [snap], ctx }]);
    h.runAll(); // the cancelled debounce must NOT fire a second push
    expect(h.pushes).toHaveLength(1);
  });

  it("cancels a pending debounced push on unmount so a stale snapshot never lands after teardown", () => {
    const h = harness();
    const s = new CanvasFleetPushScheduler(h.deps);
    s.handleSnapshot([snap], ctx); // pending debounced push
    s.handleUnmount(ctx); // should cancel it and schedule the clear instead
    h.runAll();
    // Only the clear ([]) survives — the stale snapshot push was cancelled.
    expect(h.pushes).toEqual([{ list: [], ctx }]);
  });

  describe("Phase 6.3: skip identical debounced pushes", () => {
    it("does not re-push a byte-identical snapshot on the debounced path", () => {
      const h = harness();
      const s = new CanvasFleetPushScheduler(h.deps);
      s.handleSnapshot([snap], ctx);
      h.runAll();
      s.handleSnapshot([snap], ctx); // same snapshot + ctx → redundant
      h.runAll();
      expect(h.pushes).toHaveLength(1); // second identical push skipped
    });

    it("pushes again when the snapshot actually changes", () => {
      const h = harness();
      const s = new CanvasFleetPushScheduler(h.deps);
      s.handleSnapshot([snap], ctx);
      h.runAll();
      s.handleSnapshot([{ ...snap, status: "completed" }], ctx); // changed
      h.runAll();
      expect(h.pushes).toHaveLength(2);
    });

    it("forcePush ALWAYS pushes even when identical — it answers Rust's explicit refresh request", () => {
      const h = harness();
      const s = new CanvasFleetPushScheduler(h.deps);
      s.handleSnapshot([snap], ctx);
      h.runAll();
      s.forcePush([snap], ctx); // Rust thinks it's stale — must re-push regardless
      expect(h.pushes).toHaveLength(2);
    });

    it("handleCriticalSnapshot ALWAYS pushes even when identical", () => {
      const h = harness();
      const s = new CanvasFleetPushScheduler(h.deps);
      s.handleSnapshot([snap], ctx);
      h.runAll();
      s.handleCriticalSnapshot([snap], ctx);
      expect(h.pushes).toHaveLength(2);
    });

    it("a forcePush refreshes the dedup baseline so the next identical debounced push is skipped", () => {
      const h = harness();
      const s = new CanvasFleetPushScheduler(h.deps);
      s.forcePush([snap], ctx); // push #1
      s.handleSnapshot([snap], ctx); // identical to what forcePush just sent
      h.runAll();
      expect(h.pushes).toHaveLength(1); // debounced identical push skipped
    });
  });
});

describe("dedup must not outlive its own premise", () => {
  // The dedup key is `JSON.stringify({list, ctx})`, justified by "identical (list, ctx) always
  // yields an identical payload, so skipping is safe (never misses a real change)".
  //
  // Carrying the headline into the fleet payload BROKE that premise: headlines live in their own
  // store, outside both arguments, so an agent given a brand-new instruction while its status stayed
  // `running` produced a byte-identical key — and the push was skipped as routine. A lead agent
  // calling lotus_list_fleet would have been served the previous ask, confidently.
  //
  // Caught before shipping by reading the scheduler rather than assuming it re-pushed. The fix is a
  // revision counter for everything the payload depends on that the arguments cannot see.

  it("pushes again when only the headline changed", () => {
    let revision = 1;
    const h = harness({ payloadRevision: () => revision });
    const s = new CanvasFleetPushScheduler(h.deps);
    s.handleSnapshot([snap], ctx);
    h.runAll();

    revision = 2;
    s.handleSnapshot([snap], ctx);
    h.runAll();

    expect(h.pushes).toHaveLength(2);
  });

  it("still skips a genuinely identical snapshot", () => {
    // The dedup has to keep working: a board of eight agents re-pushing on every registry tick was
    // what it was added for.
    const h = harness({ payloadRevision: () => 1 });
    const s = new CanvasFleetPushScheduler(h.deps);
    s.handleSnapshot([snap], ctx);
    h.runAll();

    s.handleSnapshot([snap], ctx);
    h.runAll();

    expect(h.pushes).toHaveLength(1);
  });
});

