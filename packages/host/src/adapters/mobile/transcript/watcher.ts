/**
 * Follows a pane's transcript file, so Chat moves when the runner writes rather than when a hook
 * happens to fire.
 *
 * **Why this exists**, measured on a real host on 2026-09-07. `TranscriptEmitter` re-reads the
 * file on every hook fire, which looked sufficient: Claude's `Stop` hook fires at the end of a
 * turn, so a read triggered by it should see the reply. It does not. Timed against the CLI's own
 * records, the assistant line is stamped `…669.546`, the hook's `curl` leaves at `…669.622`, and
 * the read it triggered still returned only the user's message — the CLI fires the hook before
 * the record it is announcing is on disk. The reply then sat unpublished for **60.1 seconds**,
 * until the CLI's idle `Notification` hook fired and the next read picked it up. That is the
 * "Chat only updates if I refresh the page" the operator reported, exactly.
 *
 * A hook fire is therefore kept as a trigger but no longer trusted as *the* trigger: whoever
 * writes the file says when there is something to read. Same conclusion `bb` reaches by owning
 * its timeline in a database — the difference is only that this reads a file somebody else owns.
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
