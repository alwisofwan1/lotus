import type { CliHookSource } from "./cli-payload.js";

/**
 * Each pane's transcript path. Not in `HookTurns`: turns age out after 30 minutes but the path
 * outlives turns and restarts, so a shared TTL would drop a quiet cell's history. `MAX_PANES`
 * bounds these instead (slice 3.1).
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
