/*
 * Text waiting to be put into one Thread's composer — filled in and focused, never sent.
 *
 * The companion of `thread-composer-registry` (which SENDS). It is an inbox rather than a
 * registered function because the Thread may not exist yet: ⌘L with no Thread in the workspace
 * opens one, and its composer mounts a few frames later. The draft waits here, keyed by session,
 * until that composer takes it — the same hand-off `workbench-open.ts` uses for a file link
 * that opens a new Editor pane.
 *
 * Several drafts before the composer takes them are joined, oldest first, so two quick ⌘L
 * presses keep both selections.
 */

const pendingDrafts = new Map<string, string>();
const draftListeners = new Map<string, Set<() => void>>();

/** Joins text arriving in one composer: a blank line between blocks, nothing before the first. */
export function appendDraft(current: string, text: string): string {
  if (!current.trim()) return text;
  return `${current.replace(/\s+$/, "")}\n\n${text}`;
}

export function requestThreadDraft(sessionId: string, text: string): void {
  const pending = pendingDrafts.get(sessionId);
  pendingDrafts.set(sessionId, pending === undefined ? text : appendDraft(pending, text));
  for (const listener of draftListeners.get(sessionId) ?? []) listener();
}

export function takeThreadDraft(sessionId: string): string | null {
  const draft = pendingDrafts.get(sessionId) ?? null;
  pendingDrafts.delete(sessionId);
  return draft;
}

export function onThreadDraft(sessionId: string, listener: () => void): () => void {
  const listeners = draftListeners.get(sessionId) ?? new Set();
  listeners.add(listener);
  draftListeners.set(sessionId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) draftListeners.delete(sessionId);
  };
}
