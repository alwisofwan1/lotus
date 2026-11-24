/**
 * Caps the number of concurrently-alive worker cells and queues spawns beyond
 * the cap (first cut of the Standalone Orchestrator — ADR-0019). Slots free on
 * explicit {@link release} (close-cell) and, self-healingly, when a previously
 * occupied worker is no longer in `liveIds` (it exited on its own) — checked on
 * each pump so no PTY exit hook is required.
 */
export class WorkerPool {
  private readonly queue: Array<QueuedJob<{ id: string }>> = [];
  private readonly occupied = new Set<string>();
  private pending = 0;

  constructor(
    private readonly maxConcurrent: number,
    private readonly liveIds: () => Set<string>,
  ) {}

  /** Submits a spawn. Resolves with its result once a slot is free and it spawns. */
  submit<T extends { id: string }>(spawn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ spawn, resolve: resolve as (v: { id: string }) => void, reject });
      this.pump();
    });
  }

  /** Frees the slot held by a closed worker and drains the queue. */
  release(id: string): void {
    if (this.occupied.delete(id)) this.pump();
  }

  /** Live workers currently occupying a slot (after reconciling exited ones). */
  activeCount(): number {
    this.reconcile();
    return this.occupied.size;
  }

  private reconcile(): void {
    const live = this.liveIds();
    for (const id of this.occupied) {
      if (!live.has(id)) this.occupied.delete(id);
    }
  }

  private pump(): void {
    this.reconcile();
    while (this.occupied.size + this.pending < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.pending += 1;
      job.spawn().then(
        (result) => {
          this.pending -= 1;
          this.occupied.add(result.id);
          job.resolve(result);
          this.pump();
        },
        (err: unknown) => {
          this.pending -= 1;
          job.reject(err);
          this.pump();
        },
      );
    }
  }
}

interface QueuedJob<T extends { id: string }> {
  spawn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}
