import type { TicketEditOutcome, TicketEdits, VaultTicketDetail } from "@/modules/tasks/services/vault-api";

/**
 * Saving a vault ticket while someone types — `bb`'s autosave, made safe for a file Obsidian may
 * be writing at the same moment.
 *
 * - Prose saves itself 800 ms after typing stops (`bb`'s `DESCRIPTION_SAVE_DELAY_MS`). Status and
 *   title save at once, like `bb`'s property menus and title blur.
 * - One save is in flight at a time, and each is sent against the revision the last one returned,
 *   so two quick saves can never race each other into a false conflict.
 * - A conflict keeps the person's unsaved text. It can be laid on top of the new file only when
 *   the file changed ELSEWHERE — none of the sections, nor the status or title, they were editing.
 *   Otherwise the one way forward is to reload, and the page says why.
 */

export interface TicketEditorState {
  detail: VaultTicketDetail;
  /** A save is on the wire. */
  saving: boolean;
  /** There are edits not yet written. */
  dirty: boolean;
  /** The file as it is NOW, when an edit was refused as stale. Unsaved edits are still held. */
  conflict: VaultTicketDetail | null;
  /** Whether the held edits can be laid onto `conflict` without touching what changed there. */
  canApplyOnTop: boolean;
  error: string | null;
  /** When the last save landed, for the "Saved" hint. */
  savedAt: number | null;
  /** Sections with text not yet written — the editors must never be reset under these. */
  held: number[];
}

type Send = (baseRevision: string, edits: TicketEdits) => Promise<TicketEditOutcome>;

interface Pending {
  status?: string;
  title?: string;
  sections: Map<number, { heading: string | null; body: string }>;
}

export const PROSE_SAVE_DELAY_MS = 800;

export class TicketSaveQueue {
  private state: TicketEditorState;
  private pending: Pending = { sections: new Map() };
  /** The detail the pending edits were made against — what a conflict is compared with. */
  private base: VaultTicketDetail;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private disposed = false;

  constructor(
    detail: VaultTicketDetail,
    private readonly send: Send,
    private readonly onChange: (state: TicketEditorState) => void,
    private readonly delayMs = PROSE_SAVE_DELAY_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.base = detail;
    this.state = {
      detail,
      saving: false,
      dirty: false,
      conflict: null,
      canApplyOnTop: false,
      error: null,
      savedAt: null,
      held: [],
    };
  }

  get snapshot(): TicketEditorState {
    return this.state;
  }

  /** Prose changed. Saved after a pause in typing. */
  queueSection(index: number, heading: string | null, body: string) {
    // Typed back to what the file already says: nothing to write for this section any more.
    if (body.trim() === (this.state.detail.sections[index]?.body ?? "").trim()) {
      this.pending.sections.delete(index);
      this.update({ dirty: this.hasPending() });
      if (!this.hasPending()) this.clearTimer();
      return;
    }
    this.pending.sections.set(index, { heading, body });
    this.update({ dirty: true });
    this.schedule();
  }

  setStatus(status: string) {
    if (status === this.state.detail.ticket.status && this.pending.status === undefined) return;
    this.pending.status = status;
    this.update({ dirty: true });
    void this.flush();
  }

  setTitle(title: string) {
    const next = title.trim();
    if (!next || (next === this.state.detail.ticket.title && this.pending.title === undefined)) return;
    this.pending.title = next;
    this.update({ dirty: true });
    void this.flush();
  }

  /** Write whatever is held, now. Also what leaving the page calls. */
  async flush(): Promise<void> {
    this.clearTimer();
    if (this.inFlight) {
      await this.inFlight;
      // Edits made while that save was out are sent next, against the revision it returned.
      if (this.hasPending() && !this.state.conflict) return this.flush();
      return;
    }
    if (!this.hasPending() || this.state.conflict || this.disposed) return;

    const edits = this.takePending();
    const baseRevision = this.state.detail.revision;
    this.update({ saving: true, error: null });

    this.inFlight = (async () => {
      try {
        const outcome = await this.send(baseRevision, edits);
        if (this.disposed) return;
        if (outcome.kind === "saved") {
          this.base = outcome.detail;
          this.update({ detail: outcome.detail, savedAt: this.now(), dirty: this.hasPending() });
        } else {
          // Not written. The edits go back to being held, merged under anything typed since.
          this.restore(edits);
          this.update({
            conflict: outcome.detail,
            canApplyOnTop: this.untouchedByThem(outcome.detail),
            dirty: true,
          });
        }
      } catch (cause) {
        if (this.disposed) return;
        this.restore(edits);
        this.update({ error: `Not saved: ${String(cause)}`, dirty: true });
      } finally {
        this.inFlight = null;
        if (!this.disposed) this.update({ saving: false });
      }
    })();
    await this.inFlight;
    if (this.hasPending() && !this.state.conflict && !this.state.error) return this.flush();
  }

  /** Throw the held edits away and take the file as it is now. */
  reload(fresh: VaultTicketDetail) {
    this.clearTimer();
    this.pending = { sections: new Map() };
    this.base = fresh;
    this.update({ detail: fresh, conflict: null, canApplyOnTop: false, dirty: false, error: null });
  }

  /** Lay the held edits onto the file as it is now — only offered when that is safe. */
  async applyOnTop(): Promise<void> {
    const theirs = this.state.conflict;
    if (!theirs || !this.state.canApplyOnTop) return;
    this.base = theirs;
    this.update({ detail: theirs, conflict: null, canApplyOnTop: false });
    await this.flush();
  }

  /** The file changed on disk while nothing was being edited: take it without asking. */
  externalChange(fresh: VaultTicketDetail) {
    if (fresh.revision === this.state.detail.revision) return;
    if (!this.hasPending() && !this.inFlight) {
      this.reload(fresh);
      return;
    }
    // Something is held: say so now rather than at the next save.
    this.update({ conflict: fresh, canApplyOnTop: this.untouchedByThem(fresh) });
  }

  dispose() {
    this.disposed = true;
    this.clearTimer();
  }

  // ── internals ──

  private untouchedByThem(theirs: VaultTicketDetail): boolean {
    const mine = this.base;
    for (const [index, edit] of this.pending.sections) {
      const before = mine.sections[index];
      const now = theirs.sections[index];
      if (!before || !now) return false;
      if ((before.heading ?? null) !== (now.heading ?? null) || before.body !== now.body) return false;
      if ((edit.heading ?? null) !== (now.heading ?? null)) return false;
    }
    if (this.pending.status !== undefined && theirs.ticket.status !== mine.ticket.status) return false;
    if (this.pending.title !== undefined && theirs.ticket.title !== mine.ticket.title) return false;
    return true;
  }

  private hasPending() {
    return this.pending.sections.size > 0 || this.pending.status !== undefined || this.pending.title !== undefined;
  }

  private takePending(): TicketEdits {
    const { status, title, sections } = this.pending;
    this.pending = { sections: new Map() };
    return {
      ...(status !== undefined ? { status } : {}),
      ...(title !== undefined ? { title } : {}),
      sections: [...sections].map(([index, edit]) => ({ index, heading: edit.heading, body: edit.body })),
    };
  }

  /** Put edits back under whatever was typed after they were taken — newer text wins. */
  private restore(edits: TicketEdits) {
    if (edits.status !== undefined && this.pending.status === undefined) this.pending.status = edits.status;
    if (edits.title !== undefined && this.pending.title === undefined) this.pending.title = edits.title;
    for (const section of edits.sections ?? []) {
      if (!this.pending.sections.has(section.index)) {
        this.pending.sections.set(section.index, { heading: section.heading, body: section.body });
      }
    }
  }

  private schedule() {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private update(patch: Partial<TicketEditorState>) {
    this.state = { ...this.state, ...patch, held: [...this.pending.sections.keys()] };
    this.onChange(this.state);
  }
}
