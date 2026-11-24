/**
 * Concurrency slots for a graph run.
 *
 * The scheduler decides *what* may run; this decides *how many* run at once. Without it a wide
 * graph dispatches every root in the same tick, and each dispatch is a real PTY plus a real CLI
 * process — a graph with a dozen roots opens a dozen agent processes on the machine at once.
 *
 * Dispatch stays synchronous when a slot is free, so a run that fits under the limit behaves
 * exactly as it did before this existed. Only the overflow waits, and it is released FIFO the
 * moment an earlier node reports a result.
 *
 * Pure and injectable (`run` is the only side effect) so the policy is unit-testable without a
 * canvas, a registry, or a PTY.
 */

/** Ceiling on how many agent nodes may be in flight at once, across every graph run. */
export const DEFAULT_MAX_CONCURRENT_RUNS = 8;

/**
 * Resolves the limit for a run: an explicit request wins, otherwise leave the host two cores for
 * the UI and the CLI processes themselves, capped at {@link DEFAULT_MAX_CONCURRENT_RUNS}.
 */
export function resolveMaxConcurrentRuns(requested?: number): number {
  if (typeof requested === "number" && Number.isFinite(requested) && requested >= 1) {
    return Math.floor(requested);
  }
  const cores = typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency;
  if (typeof cores === "number" && Number.isFinite(cores) && cores > 0) {
    return Math.max(1, Math.min(DEFAULT_MAX_CONCURRENT_RUNS, Math.floor(cores) - 2));
  }
  return DEFAULT_MAX_CONCURRENT_RUNS;
}

export interface RunSlots {
  /** Dispatches `nodeId` now when a slot is free, otherwise queues it. */
  submit(nodeId: string): void;
  /** Frees the slot `nodeId` held and starts whatever was waiting behind it. */
  release(nodeId: string): void;
  /** Nodes currently holding a slot. */
  inFlight(): number;
  /** Nodes waiting for a slot. */
  queued(): number;
  /** Drops this run's nodes still waiting for a slot; the ones in flight keep theirs. */
  dropQueued(): void;
  /** Drops the queue and refuses further dispatch (session disposed or settled). */
  clear(): void;
}

/**
 * One concurrency budget shared by many runs. Each run takes a {@link RunSlots} lease; the pool
 * counts every lease's in-flight nodes against one limit, and a freed slot goes to the oldest
 * waiting node of ANY lease (FIFO across runs). Without this, N runs = N × the host limit.
 */
export interface RunSlotPool {
  /** A per-run view of the pool. `run` dispatches one node and returns whether it was accepted. */
  lease(run: (nodeId: string) => boolean): RunSlots;
  /** Nodes holding a slot, across every lease. */
  inFlight(): number;
  /** Nodes waiting for a slot, across every lease. */
  queued(): number;
}

interface Waiting {
  nodeId: string;
  start: (nodeId: string) => void;
  owner: object;
}

export function createRunSlotPool(limit?: number): RunSlotPool {
  const max = resolveMaxConcurrentRuns(limit);
  let active = 0;
  const waiting: Waiting[] = [];

  // Re-entrant on purpose: a node that completes synchronously inside its own dispatch releases
  // its slot while this loop is still running, and the loop simply re-checks the condition.
  const drain = () => {
    while (active < max && waiting.length > 0) {
      const next = waiting.shift()!;
      next.start(next.nodeId);
    }
  };

  return {
    lease(run) {
      const owner = {};
      const mine = new Set<string>();
      let stopped = false;

      // The slot is claimed *before* `run` so a node that completes synchronously inside its own
      // dispatch releases a slot that actually exists. A refused dispatch never holds a slot —
      // otherwise a node whose runner vanished would wedge every run behind a slot nobody frees.
      const start = (nodeId: string) => {
        mine.add(nodeId);
        active += 1;
        if (!run(nodeId) && mine.delete(nodeId)) active -= 1;
      };
      const dropQueued = () => {
        for (let i = waiting.length - 1; i >= 0; i -= 1) {
          if (waiting[i].owner === owner) waiting.splice(i, 1);
        }
      };

      return {
        submit(nodeId) {
          if (stopped) return;
          if (active < max) start(nodeId);
          else waiting.push({ nodeId, start, owner });
        },
        release(nodeId) {
          // Every session hears every result; only the lease that holds the node may free it.
          if (!mine.delete(nodeId)) return;
          active -= 1;
          drain();
        },
        inFlight: () => mine.size,
        queued: () => waiting.filter((w) => w.owner === owner).length,
        dropQueued,
        clear() {
          if (stopped) return;
          stopped = true;
          dropQueued();
          active -= mine.size;
          mine.clear();
          drain(); // the slots this run held go to the other runs
        },
      };
    },
    inFlight: () => active,
    queued: () => waiting.length,
  };
}

let shared: RunSlotPool | null = null;

/** The app-wide pool every graph run draws from unless it brings its own. Sized from the host. */
export function sharedRunSlotPool(): RunSlotPool {
  shared ??= createRunSlotPool();
  return shared;
}

/** A private pool with a single lease — one run with its own limit, isolated from other runs. */
export function createRunSlots(limit: number | undefined, run: (nodeId: string) => boolean): RunSlots {
  return createRunSlotPool(limit).lease(run);
}
