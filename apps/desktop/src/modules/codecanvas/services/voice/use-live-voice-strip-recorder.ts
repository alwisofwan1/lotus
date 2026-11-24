"use client";
import { useCallback, useReducer, useRef } from "react";
import { initialLiveVoiceStrip, reduceLiveVoiceStrip, type LiveVoiceStripState } from "@/modules/voice-core/live-voice-strip";
import type { S2sTranscriptMeta } from "./use-s2s-session";

export interface LiveVoiceStripRecorder {
  strip: LiveVoiceStripState;
  /** The session's `onTranscript`: both sides' words, by turn. */
  recordTranscript: (text: string, isFinal: boolean, meta: S2sTranscriptMeta) => void;
  /** Runs a tool call and files it as one line, in the turn in progress when it was called — a slow
   *  tool can finish after the next turn has begun. */
  recordTool: <R extends { ok: boolean }>(call: { name: string; args: Record<string, unknown> }, run: () => Promise<R>) => Promise<R>;
  /** The session's current turn. Tool calls carry none of their own. */
  noteTurn: (turn: number) => void;
  /** Empty the strip for a new session. */
  reset: () => void;
}

/** Records a Live Voice session for the strip above the composer (plans/composer-voice-ux ticket 09). */
export function useLiveVoiceStripRecorder(): LiveVoiceStripRecorder {
  const [strip, dispatch] = useReducer(reduceLiveVoiceStrip, undefined, initialLiveVoiceStrip);
  const turnRef = useRef(0);
  const recordTranscript = useCallback((text: string, isFinal: boolean, meta: S2sTranscriptMeta) => {
    if (!meta.speaker) return;
    dispatch({ type: "transcript", speaker: meta.speaker, turn: meta.turn, text, isFinal, itemId: meta.itemId, cumulative: meta.cumulative });
  }, []);
  const recordTool = useCallback(
    async <R extends { ok: boolean }>(call: { name: string; args: Record<string, unknown> }, run: () => Promise<R>): Promise<R> => {
      const turn = turnRef.current;
      const result = await run();
      dispatch({ type: "tool", turn, name: call.name, args: call.args, ok: result.ok });
      return result;
    },
    [],
  );
  const noteTurn = useCallback((turn: number) => {
    turnRef.current = turn;
  }, []);
  const reset = useCallback(() => dispatch({ type: "reset" }), []);
  return { strip, recordTranscript, recordTool, noteTurn, reset };
}
