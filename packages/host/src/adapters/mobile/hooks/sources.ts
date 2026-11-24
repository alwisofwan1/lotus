import type { CliHookSource } from "./cli-payload.js";

/**
 * Where each pane's CLI keeps its own transcript, as the CLI itself reported it.
 *
 * **Why this is not in `HookTurns`.** The two facts have different lifetimes. A turn ages out
 * after 30 minutes, because "is this cell waiting" goes stale and a `needs-input` from this
 * morning is not a question anybody still holds. A transcript path does not go stale — the file
 * is durable, the CLI wrote it, and it outlives the turn, the host process and any restart. On
 * the same TTL, a cell would lose a perfectly readable history for the crime of being quiet.
 *
 * Nothing ages these out, so `MAX_PANES` bounds them instead: a host months into its life has
 * spawned cells it will never hear from again (slice 3.1).
 */
const MAX_PANES = 512;

export class CliSources {
  private readonly sources = new Map<string, { source: CliHookSource; at: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxPanes: number = MAX_PANES,
  ) {}

  /** The newest word wins: a resumed session writes a new file, and yesterday's is the wrong one. */
  record(paneId: string, source: CliHookSource): void {
    this.sources.set(paneId, { source, at: this.now() });
    this.evictIfFull();
  }

  sourceOf(paneId: string): CliHookSource | undefined {
    return this.sources.get(paneId)?.source;
  }

  /** Called when a cell closes: a closed cell has no history anyone is about to open. */
  forget(paneId: string): void {
    this.sources.delete(paneId);
  }

  size(): number {
    return this.sources.size;
  }

  private evictIfFull(): void {
    while (this.sources.size > this.maxPanes) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.sources) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) return;
      this.sources.delete(oldestKey);
    }
  }
}
