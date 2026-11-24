"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TicketSaveQueue, type TicketEditorState } from "@/modules/tasks/editor/ticket-save-queue";
import type { TicketEditOutcome, TicketEdits, VaultTicketDetail } from "@/modules/tasks/services/vault-api";

/**
 * One open vault ticket, editable: the save queue for it, and the plumbing around it.
 *
 * - A queue per FILE. Stepping to another ticket flushes the old one first, so ↑ ↓ never drops
 *   the last 800 ms of typing.
 * - When the vault folder changes on disk (`vaultVersion`), the open ticket is re-read and handed
 *   to the queue, which takes it silently when nothing is held and flags a conflict when
 *   something is.
 * - `resetKeys` tell each section editor when ITS text was REPLACED (reload, outside change) as
 *   opposed to merely saved — only the first may move a caret.
 */

export interface TicketEditing {
  state: TicketEditorState;
  /** Per section: bumped when that section's text was REPLACED and its editor must take it in. */
  resetKeys: Readonly<Record<number, number>>;
  setSection: (index: number, heading: string | null, body: string) => void;
  setStatus: (status: string) => void;
  setTitle: (title: string) => void;
  reload: () => void;
  applyOnTop: () => void;
}

export function useTicketEditing(
  detail: VaultTicketDetail | null,
  save: ((file: string, baseRevision: string, edits: TicketEdits) => Promise<TicketEditOutcome>) | undefined,
  reread: (file: string) => Promise<VaultTicketDetail | null>,
  vaultVersion: number | undefined,
): TicketEditing | null {
  const file = detail?.ticket.file ?? null;
  const [state, setState] = useState<TicketEditorState | null>(null);
  const [resetKeys, setResetKeys] = useState<Record<number, number>>({});
  const queueRef = useRef<TicketSaveQueue | null>(null);
  const lastDetail = useRef<VaultTicketDetail | null>(null);
  const lastSavedAt = useRef<number | null>(null);
  const lastHeld = useRef<number[]>([]);

  // One queue per file.
  useEffect(() => {
    if (!detail || !save) {
      queueRef.current = null;
      setState(null);
      return;
    }
    const queue = new TicketSaveQueue(detail, (base, edits) => save(detail.ticket.file, base, edits), (next) => {
      // Detail changed without a save landing = it was REPLACED (reload, outside change, laid on
      // top). A section's editor is reset when its text differs from what it showed: it changed
      // in the file, or it was holding typing that has just been thrown away.
      const before = lastDetail.current;
      if (before && next.detail !== before && next.savedAt === lastSavedAt.current) {
        const dropped = lastHeld.current.filter((index) => !next.held.includes(index));
        const changed = next.detail.sections
          .map((section, index) => ({ section, index }))
          .filter(({ section, index }) => {
            const old = before.sections[index];
            return !old || old.body !== section.body || (old.heading ?? null) !== (section.heading ?? null);
          })
          .map(({ index }) => index)
          .filter((index) => !next.held.includes(index));
        const bump = new Set([...dropped, ...changed]);
        if (bump.size > 0) {
          setResetKeys((current) => {
            const out = { ...current };
            for (const index of bump) out[index] = (out[index] ?? 0) + 1;
            return out;
          });
        }
      }
      lastDetail.current = next.detail;
      lastSavedAt.current = next.savedAt;
      lastHeld.current = next.held;
      setState(next);
    });
    queueRef.current = queue;
    lastDetail.current = detail;
    lastSavedAt.current = null;
    lastHeld.current = [];
    setState(queue.snapshot);
    return () => {
      // Leaving this ticket: write what is held, then let the queue go.
      void queue.flush().finally(() => queue.dispose());
    };
    // Keyed on the FILE: a new `detail` object for the same ticket (the queue's own saves) must not
    // rebuild the queue and lose what it holds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, Boolean(save)]);

  // The vault moved on disk: re-read the open ticket and let the queue decide what that means.
  const firstVersion = useRef(vaultVersion);
  useEffect(() => {
    if (!file || vaultVersion === undefined || vaultVersion === firstVersion.current) return;
    let cancelled = false;
    void reread(file).then((fresh) => {
      if (!cancelled && fresh) queueRef.current?.externalChange(fresh);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultVersion]);

  const setSection = useCallback((index: number, heading: string | null, body: string) => {
    queueRef.current?.queueSection(index, heading, body);
  }, []);
  const setStatus = useCallback((status: string) => queueRef.current?.setStatus(status), []);
  const setTitle = useCallback((title: string) => queueRef.current?.setTitle(title), []);
  const reload = useCallback(() => {
    const queue = queueRef.current;
    if (!queue || !file) return;
    const conflict = queue.snapshot.conflict;
    if (conflict) {
      queue.reload(conflict);
      return;
    }
    void reread(file).then((fresh) => fresh && queue.reload(fresh));
  }, [file, reread]);
  const applyOnTop = useCallback(() => void queueRef.current?.applyOnTop(), []);

  return useMemo(
    () => (state ? { state, resetKeys, setSection, setStatus, setTitle, reload, applyOnTop } : null),
    [applyOnTop, reload, resetKeys, setSection, setStatus, setTitle, state],
  );
}
