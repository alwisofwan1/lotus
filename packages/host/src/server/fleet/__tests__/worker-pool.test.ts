import { describe, it, expect } from "vitest";
import { WorkerPool } from "../worker-pool.js";

/** A deferred promise whose resolve is captured for manual control in tests. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("WorkerPool", () => {
  it("runs up to maxConcurrent spawns immediately, queueing the rest until a slot frees", async () => {
    const live = new Set<string>();
    const pool = new WorkerPool(2, () => live);
    const gates = [deferred<{ id: string }>(), deferred<{ id: string }>(), deferred<{ id: string }>()];
    const started: number[] = [];

    const submits = gates.map((g, i) =>
      pool.submit(() => { started.push(i); return g.promise; }));

    await Promise.resolve();
    expect(started).toEqual([0, 1]); // 3rd is queued behind the cap

    // Both spawns complete and their workers are alive — the cap (2 alive) is now full.
    gates[0]!.resolve({ id: "w0" }); live.add("w0");
    gates[1]!.resolve({ id: "w1" }); live.add("w1");
    await Promise.all([submits[0], submits[1]]);
    expect(started).toEqual([0, 1]); // still full: spawning != freeing

    pool.release("w0"); // a worker is closed → its slot frees
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]); // 3rd now dequeues
    gates[2]!.resolve({ id: "w2" });
    await submits[2];
  });

  it("returns the spawned value to each caller", async () => {
    const pool = new WorkerPool(4, () => new Set());
    await expect(pool.submit(async () => ({ id: "x", paneId: "x" }))).resolves.toEqual({ id: "x", paneId: "x" });
  });

  it("frees the slot when a spawn fails and still drains the queue", async () => {
    const pool = new WorkerPool(1, () => new Set());
    await expect(pool.submit(async () => { throw new Error("spawn boom"); })).rejects.toThrow("spawn boom");
    await expect(pool.submit(async () => ({ id: "ok" }))).resolves.toEqual({ id: "ok" });
  });

  it("release() frees a slot for the next queued spawn", async () => {
    const live = new Set<string>(["a"]);
    const pool = new WorkerPool(1, () => live);
    await pool.submit(async () => ({ id: "a" }));
    const g = deferred<{ id: string }>();
    let started = false;
    const p = pool.submit(() => { started = true; return g.promise; });
    await Promise.resolve();
    expect(started).toBe(false); // blocked by the cap
    pool.release("a");
    await Promise.resolve();
    expect(started).toBe(true);
    g.resolve({ id: "b" });
    await p;
  });

  it("reconciles dead workers out of the count on the next submit (self-healing)", async () => {
    const live = new Set<string>(["a"]);
    const pool = new WorkerPool(1, () => live);
    await pool.submit(async () => ({ id: "a" }));
    expect(pool.activeCount()).toBe(1);
    live.delete("a"); // worker exited on its own, no close-cell called
    const g = deferred<{ id: string }>();
    let started = false;
    pool.submit(() => { started = true; return g.promise; });
    await Promise.resolve();
    expect(started).toBe(true); // dead 'a' was reconciled away, freeing the slot
    g.resolve({ id: "b" });
  });
});
