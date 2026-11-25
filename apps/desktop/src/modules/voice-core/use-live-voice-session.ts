"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { S2sPhase } from "./s2s-session";
import { liveVoiceSummary } from "./live-voice-strip";

/** How long the summary line stays after End when nothing else hides it first. */
export const LIVE_VOICE_SUMMARY_MS = 8_000;

/** Phases of a session that is connected and talking. Before the first one there is no session to time. */
const CONNECTED: ReadonlySet<S2sPhase> = new Set<S2sPhase>(["listening", "user", "thinking", "agent", "reconnecting"]);

export interface LiveVoiceSessionView {
  /** When the session connected (epoch ms), for the strip's timer; null until then. */
  startedAt: number | null;
  /** "Live Voice · N actions · m:ss" after End, until dismissed, the next send, or 8 s. */
  summary: string | null;
  dismissSummary: () => void;
  /** The composer sent something: the summary has done its job. */
  noteSend: () => void;
}

/**
 * What a composer keeps around one Live Voice session (plans/composer-voice-ux ticket 09): the
 * session timer, the summary line after End, and the text that was in the field when Live Voice
 * started. That text is stashed (the field is emptied, so nothing typed can be sent behind the
 * conversation) and written back on End, the way ⌘K gives the field back. Mode-neutral: the
 * composer passes its own field as `stash`.
 */
export function useLiveVoiceSession({
  active,
  phase,
  actions,
  stash,
  sending = false,
  endNote,
  now = Date.now,
}: {
  active: boolean;
  phase: S2sPhase;
  /** The composer is sending something (typed, spoken or held): the summary has done its job. */
  sending?: boolean;
  /** Tool calls this session so far. */
  actions: number;
  stash: { read: () => string; write: (text: string) => void };
  /** Why the session closed by itself ("Live voice ended after 60 minutes."); replaces the summary line. */
  endNote?: string;
  /** The clock the session is timed by. */
  now?: () => number;
}): LiveVoiceSessionView {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  /** When the session stopped working (an error), so the time on the error screen is not counted. */
  const [failedAt, setFailedAt] = useState<number | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  // Session edges are tracked while rendering, not in effects: the timer starts on the first
  // connected phase, and End turns the session into its summary line.
  const [wasActive, setWasActive] = useState(active);
  if (active && startedAt === null && CONNECTED.has(phase)) setStartedAt(now());
  if (active && phase === "error" && startedAt !== null && failedAt === null) setFailedAt(now());
  // Retry goes from the error straight to a new connection without ever being inactive: a new
  // session, timed from scratch.
  if (active && phase === "connecting" && (startedAt !== null || failedAt !== null)) {
    setStartedAt(null);
    setFailedAt(null);
  }
  if (active !== wasActive) {
    setWasActive(active);
    if (active) setSummary(null);
    else {
      if (startedAt !== null) setSummary(endNote ?? liveVoiceSummary(actions, (failedAt ?? now()) - startedAt));
      setStartedAt(null);
      setFailedAt(null);
    }
  }
  if (sending && summary !== null) setSummary(null);

  // The field is the composer's, so the stash writes it from an effect.
  const stashRef = useRef(stash);
  useEffect(() => {
    stashRef.current = stash;
  });
  const stashedRef = useRef<string | null>(null);
  useEffect(() => {
    if (active) {
      const typed = stashRef.current.read();
      stashedRef.current = typed;
      if (typed) stashRef.current.write("");
      return;
    }
    // Also runs on mount, before any session: nothing stashed, nothing to give back.
    const stashed = stashedRef.current;
    stashedRef.current = null;
    if (stashed) stashRef.current.write(stashed);
  }, [active]);

  useEffect(() => {
    if (!summary) return;
    const id = setTimeout(() => setSummary(null), LIVE_VOICE_SUMMARY_MS);
    return () => clearTimeout(id);
  }, [summary]);

  const dismissSummary = useCallback(() => setSummary(null), []);
  return { startedAt, summary, dismissSummary, noteSend: dismissSummary };
}
