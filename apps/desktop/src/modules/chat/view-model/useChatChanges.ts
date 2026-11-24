"use client";

import { useCallback, useEffect, useState } from "react";

import type { Changes } from "../domain/changes";
import { getChatChanges } from "../runtime/chat-runtime-client";

export interface ChatChangesView {
  changes: Changes | null;
  error: string | null;
  reload: () => void;
}

/** The last read per thread, shown while the next read runs, so going back to a chat does not
 *  drop its changes bar and bring it back a moment later (the composer below would jump twice). */
const lastRead = new Map<string, { changes: Changes | null; error: string | null }>();
const LAST_READ_LIMIT = 16;
/** Per thread, the newest read started: an older one landing late must not replace a newer result. */
const newestRead = new Map<string, number>();
let reads = 0;

function keep(threadId: string, read: { changes: Changes | null; error: string | null }) {
  lastRead.delete(threadId);
  lastRead.set(threadId, read);
  if (lastRead.size > LAST_READ_LIMIT) lastRead.delete(lastRead.keys().next().value!);
}

/**
 * Git in the thread's folder (#281). Read again when `refreshKey` changes (a turn starts or ends,
 * the agent touches a file) and when the window regains focus, since the user edits elsewhere.
 */
export function useChatChanges(threadId: string | null, refreshKey: string): ChatChangesView {
  // Tagged with its thread, so a switch never shows the previous folder's files.
  const [result, setResult] = useState<{ threadId: string; changes: Changes | null; error: string | null } | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!threadId) return;
    let live = true;
    const ticket = ++reads;
    newestRead.set(threadId, ticket);
    const land = (read: { changes: Changes | null; error: string | null }) => {
      if (newestRead.get(threadId) === ticket) keep(threadId, read);
      if (live) setResult({ threadId, ...read });
    };
    getChatChanges(threadId).then(
      (changes) => land({ changes, error: null }),
      (reason: unknown) => land({ changes: null, error: reason instanceof Error ? reason.message : String(reason) }),
    );
    return () => {
      live = false;
    };
  }, [threadId, refreshKey, nonce]);

  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  const mine = threadId ? (result?.threadId === threadId ? result : (lastRead.get(threadId) ?? null)) : null;
  return { changes: mine?.changes ?? null, error: mine?.error ?? null, reload };
}
