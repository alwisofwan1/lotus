import { describe, it, expect, vi } from "vitest";
import {
  createRunSlots,
  createRunSlotPool,
  resolveMaxConcurrentRuns,
  sharedRunSlotPool,
  DEFAULT_MAX_CONCURRENT_RUNS,
} from "../graph-run-slots";

describe("createRunSlots", () => {
  it("starts up to the limit immediately and queues the rest", () => {
    const started: string[] = [];
    const slots = createRunSlots(2, (id) => { started.push(id); return true; });

    ["a", "b", "c", "d"].forEach((id) => slots.submit(id));

    expect(started).toEqual(["a", "b"]);
    expect(slots.inFlight()).toBe(2);
    expect(slots.queued()).toBe(2);
  });

  it("releases a slot in FIFO order as runs finish", () => {
    const started: string[] = [];
    const slots = createRunSlots(1, (id) => { started.push(id); return true; });

    ["a", "b", "c"].forEach((id) => slots.submit(id));
    expect(started).toEqual(["a"]);

    slots.release("a");
    expect(started).toEqual(["a", "b"]);
    slots.release("b");
    expect(started).toEqual(["a", "b", "c"]);
    slots.release("c");
    expect(slots.inFlight()).toBe(0);
    expect(slots.queued()).toBe(0);
  });

  it("does not hold a slot for a dispatch the runner refuses", () => {
    const started: string[] = [];
    const slots = createRunSlots(1, (id) => { started.push(id); return id !== "a"; });

    slots.submit("a"); // refused — must free its slot straight away
    slots.submit("b");

    expect(started).toEqual(["a", "b"]);
    expect(slots.inFlight()).toBe(1);
    expect(slots.queued()).toBe(0);
  });

  it("keeps draining when a run completes synchronously inside its own dispatch", () => {
    const started: string[] = [];
    const slots = createRunSlots(1, (id) => {
      started.push(id);
      slots.release(id); // synchronous completion, as a cached/no-op node would do
      return true;
    });

    ["a", "b", "c"].forEach((id) => slots.submit(id));

    expect(started).toEqual(["a", "b", "c"]);
    expect(slots.inFlight()).toBe(0);
  });

  it("stops dispatching once cleared", () => {
    const run = vi.fn(() => true);
    const slots = createRunSlots(1, run);

    slots.submit("a");
    slots.submit("b");
    slots.clear();
    slots.release("a");
    slots.submit("c");

    expect(run).toHaveBeenCalledTimes(1);
    expect(slots.queued()).toBe(0);
  });
});

describe("createRunSlotPool", () => {
  it("caps every lease together, not each lease on its own", () => {
    const pool = createRunSlotPool(2);
    const started: string[] = [];
    const one = pool.lease((id) => { started.push(id); return true; });
    const two = pool.lease((id) => { started.push(id); return true; });

    one.submit("a1");
    two.submit("b1");
    one.submit("a2");
    two.submit("b2");

    expect(started).toEqual(["a1", "b1"]);
    expect(pool.inFlight()).toBe(2);
    expect(pool.queued()).toBe(2);
  });

  it("starts the oldest waiting node of ANY lease when a slot frees", () => {
    const pool = createRunSlotPool(1);
    const started: string[] = [];
    const one = pool.lease((id) => { started.push(id); return true; });
    const two = pool.lease((id) => { started.push(id); return true; });

    one.submit("a1");
    two.submit("b1"); // waits on the slot a1 holds
    one.submit("a2"); // waits behind b1

    one.release("a1");
    expect(started).toEqual(["a1", "b1"]);
    two.release("b1");
    expect(started).toEqual(["a1", "b1", "a2"]);
  });

  it("ignores a release for a node the lease does not hold", () => {
    const pool = createRunSlotPool(1);
    const one = pool.lease(() => true);
    const two = pool.lease(() => true);

    one.submit("a1");
    two.release("a1"); // every session sees every result — only the owner may free the slot

    expect(pool.inFlight()).toBe(1);
  });

  it("hands a cleared lease's slots and queue back to the other leases", () => {
    const pool = createRunSlotPool(1);
    const started: string[] = [];
    const one = pool.lease((id) => { started.push(id); return true; });
    const two = pool.lease((id) => { started.push(id); return true; });

    one.submit("a1");
    one.submit("a2");
    two.submit("b1");
    one.clear();

    expect(started).toEqual(["a1", "b1"]); // a2 dropped, b1 took the freed slot
    expect(pool.inFlight()).toBe(1);
    expect(pool.queued()).toBe(0);
  });

  it("is one pool for the whole app", () => {
    expect(sharedRunSlotPool()).toBe(sharedRunSlotPool());
  });
});

describe("RunSlots.dropQueued", () => {
  it("drops only this lease's waiting nodes; its in-flight node keeps its slot", () => {
    const pool = createRunSlotPool(1);
    const started: string[] = [];
    const mine = pool.lease((id) => { started.push(id); return true; });
    const other = pool.lease((id) => { started.push(id); return true; });
    mine.submit("a");
    mine.submit("b");
    other.submit("x");

    mine.dropQueued();
    expect(mine.queued()).toBe(0);
    expect(mine.inFlight()).toBe(1);
    expect(pool.inFlight()).toBe(1);

    mine.release("a");
    expect(started).toEqual(["a", "x"]);
  });
});

describe("resolveMaxConcurrentRuns", () => {
  it("honors an explicit positive request", () => {
    expect(resolveMaxConcurrentRuns(3)).toBe(3);
    expect(resolveMaxConcurrentRuns(1)).toBe(1);
  });

  it("falls back to the default for absent or nonsensical requests", () => {
    expect(resolveMaxConcurrentRuns(undefined)).toBeGreaterThanOrEqual(1);
    expect(resolveMaxConcurrentRuns(0)).toBeGreaterThanOrEqual(1);
    expect(resolveMaxConcurrentRuns(-4)).toBeGreaterThanOrEqual(1);
    expect(resolveMaxConcurrentRuns(Number.NaN)).toBeGreaterThanOrEqual(1);
  });

  it("never exceeds the default ceiling when derived from the host", () => {
    expect(resolveMaxConcurrentRuns(undefined)).toBeLessThanOrEqual(DEFAULT_MAX_CONCURRENT_RUNS);
  });
});
