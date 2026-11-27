/**
 * Follows a pane's transcript file. Claude's `Stop` hook fires before its record is on disk, so
 * a hook-triggered read misses the reply until the next hook (~60s); the file's own writes
 * are the trigger instead.
 */
export interface TranscriptWatch {
  close(): void;
}

export interface TranscriptWatcherDeps {
  /** Injected `fs.watch`. May throw — a path that cannot be watched is not an error here. */
  watch(path: string, onChange: () => void): TranscriptWatch;
  /** Whether the pane is still running. A closed cell writes nothing more. */
  isLive(paneId: string): boolean;
  onChanged(paneId: string): void;
}

interface Followed {
  path: string;
  watch: TranscriptWatch;
  timer?: ReturnType<typeof setTimeout>;
}

export class TranscriptWatcher {
  private readonly followed = new Map<string, Followed>();

  /**
   * 80ms. A turn's records land in a burst — assistant line, attachments, system lines — and
   * reading between them would publish the same turn several times over.
   */
  constructor(private readonly deps: TranscriptWatcherDeps, private readonly debounceMs = 80) {}

  /** Watches this pane's file, replacing an earlier one. Idempotent for the same path. */
  follow(paneId: string, path: string): void {
    this.reap();
    const held = this.followed.get(paneId);
    if (held?.path === path) return;
    if (held !== undefined) this.forget(paneId);

    let watch: TranscriptWatch;
    try {
      watch = this.deps.watch(path, () => this.noticed(paneId));
    } catch {
      // Nothing recorded: the next hook fire tries again, by which time the CLI has created it.
      return;
    }
    this.followed.set(paneId, { path, watch });
  }

  /** Releases a pane's watch and cancels anything it had pending. */
  forget(paneId: string): void {
    const held = this.followed.get(paneId);
    if (held === undefined) return;
    if (held.timer !== undefined) clearTimeout(held.timer);
    held.watch.close();
    this.followed.delete(paneId);
  }

  size(): number {
    return this.followed.size;
  }

  private noticed(paneId: string): void {
    const held = this.followed.get(paneId);
    if (held === undefined) return;
    if (held.timer !== undefined) clearTimeout(held.timer);
    held.timer = setTimeout(() => {
      delete held.timer;
      if (!this.deps.isLive(paneId)) {
        this.forget(paneId);
        return;
      }
      this.deps.onChanged(paneId);
    }, this.debounceMs);
  }

  /** A closed cell's file never changes again, so its watch would otherwise be held for good. */
  private reap(): void {
    for (const paneId of [...this.followed.keys()]) {
      if (!this.deps.isLive(paneId)) this.forget(paneId);
    }
  }
}
