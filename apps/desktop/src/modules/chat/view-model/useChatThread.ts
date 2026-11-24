"use client";

import { useEffect, useMemo, useState } from "react";

import type { ThreadEventEnvelope } from "../domain/thread-event";
import { applyThreadEvents, emptyThreadState, type ThreadState } from "../domain/thread-state";
import { buildTimelineRows, type TimelineRow } from "../domain/timeline";
import { subscribeChatThread } from "../runtime/chat-runtime-client";

export interface ChatThreadView {
  state: ThreadState | null;
  rows: TimelineRow[];
  error: string | null;
}

/** Threads kept folded after the user leaves them, so going back draws at once. Oldest go first. */
const CACHE_LIMIT = 16;
const cache = new Map<string, ThreadState>();

function remember(state: ThreadState) {
  cache.delete(state.threadId);
  cache.set(state.threadId, state);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

/**
 * Streams one thread: the stored history first, then each new event. Events are folded once per
 * animation frame, so a fast token stream re-renders the timeline at most once a frame.
 *
 * The history is drawn whole, never partway: until the runtime says the replay has arrived, events
 * are folded but not shown. A partly replayed thread looks like a live one (its last reply still
 * "running"), so drawing it frame by frame retyped old replies and moved the scroll on every
 * switch. A thread seen before shows its kept state at once and replays only what it missed.
 */
export function useChatThread(threadId: string | null): ChatThreadView {
  // Tagged with its thread, so a switch never shows the previous thread's rows for a frame.
  const [snapshot, setSnapshot] = useState<{ threadId: string; state: ThreadState; error: string | null } | null>(null);

  useEffect(() => {
    if (!threadId) return;
    let current = cache.get(threadId) ?? emptyThreadState(threadId);
    let pending: ThreadEventEnvelope[] = [];
    let frame = 0;
    let replayed = false;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;

    const fold = () => {
      if (pending.length === 0) return;
      current = applyThreadEvents(current, pending);
      pending = [];
      remember(current);
    };
    const flush = () => {
      frame = 0;
      fold();
      setSnapshot({ threadId, state: current, error: null });
    };
    subscribeChatThread({
      threadId,
      afterSeq: current.lastSeq,
      onEvent: (envelope) => {
        pending.push(envelope);
        if (replayed && frame === 0) frame = requestAnimationFrame(flush);
      },
      onReplayed: () => {
        if (disposed) return;
        replayed = true;
        flush();
      },
    }).then(
      (stop) => {
        if (disposed) stop();
        else unsubscribe = stop;
      },
      (reason: unknown) => {
        if (disposed) return;
        fold();
        setSnapshot({ threadId, state: current, error: reason instanceof Error ? reason.message : String(reason) });
      },
    );
    return () => {
      disposed = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      // Events folded for a frame that never came still belong to the kept state.
      fold();
      unsubscribe?.();
    };
  }, [threadId]);

  const kept = threadId ? cache.get(threadId) : undefined;
  const live = snapshot && snapshot.threadId === threadId ? snapshot : null;
  // Before the first snapshot of a revisit, the kept state shows in the very first render.
  const state = live?.state ?? kept ?? null;
  const rows = useMemo(() => (state ? buildTimelineRows(state) : []), [state]);
  return { state, rows, error: live?.error ?? null };
}
