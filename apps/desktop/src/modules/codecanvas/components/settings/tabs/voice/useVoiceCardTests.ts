"use client";
// The real checks behind each Voice card's Test (mockups/lotus-voice-settings.pen, frames 02, 05
// and 06): Listen records through the same speech-to-text path Push-to-Talk uses, Speak plays a
// line through the active voice. Every outcome is recorded so the card's light reflects it.

import { useCallback, useEffect, useRef, useState } from "react";
import { useSpeechToText } from "@/modules/voice-core/use-speech-to-text";
import type { VoiceFeedback } from "@/modules/voice-core/use-voice-feedback";
import { classifyVoiceError, type VoiceTestResult } from "./voice-health";
import { recordVoiceTest } from "./voice-setup-store";

/** Listen stops by itself after this long, so a forgotten test never holds the mic. */
export const LISTEN_TEST_MAX_MS = 6000;

export type ListenTestPhase = "idle" | "listening" | "transcribing";

export interface ListenTest {
  phase: ListenTestPhase;
  /** Live words while listening (streaming engines only). */
  interim: string;
  /** The last finished test's words and stop → text time. */
  transcript: string;
  ms: number | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => void;
}

function failure(engineId: string, error: unknown): VoiceTestResult {
  const message = error instanceof Error ? error.message : String(error);
  return { engineId, at: Date.now(), ok: false, problem: classifyVoiceError(message), error: message };
}

/**
 * Push-to-Talk test. `onLevel` gets the mic level (0–1) every animation frame, so the caller
 * writes it straight to the DOM rather than into state.
 */
export function useListenTest(engineId: string | null, onLevel?: (level: number) => void): ListenTest {
  const [phase, setPhase] = useState<ListenTestPhase>("idle");
  const [transcript, setTranscript] = useState("");
  const [ms, setMs] = useState<number | null>(null);
  const phaseRef = useRef<ListenTestPhase>("idle");
  const engineRef = useRef(engineId ?? "");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopRef = useRef<() => Promise<void>>(async () => {});
  const onLevelRef = useRef(onLevel);
  useEffect(() => {
    onLevelRef.current = onLevel;
  }, [onLevel]);
  // A function, so TypeScript does not narrow the ref across awaits.
  const current = (): ListenTestPhase => phaseRef.current;

  const move = (next: ListenTestPhase) => {
    phaseRef.current = next;
    setPhase(next);
  };
  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const settle = useCallback((result: VoiceTestResult) => {
    clearTimer();
    onLevelRef.current?.(0);
    move("idle");
    recordVoiceTest("listen", result);
  }, []);

  const stt = useSpeechToText({
    onError: (message) => {
      if (phaseRef.current === "idle") return;
      settle(failure(engineRef.current, message));
    },
    onSpectrum: (bands) => {
      if (bands.length === 0) return;
      onLevelRef.current?.(Math.min(1, (bands.reduce((sum, b) => sum + b, 0) / bands.length) * 1.8));
    },
  });

  const stop = useCallback(async () => {
    if (phaseRef.current !== "listening") return;
    clearTimer();
    move("transcribing");
    const startedAt = performance.now();
    const text = await stt.stop();
    // An error during the round trip already settled the test through onError.
    if (current() !== "transcribing") return;
    const took = Math.round(performance.now() - startedAt);
    setTranscript(text);
    setMs(took);
    settle(
      text.trim()
        ? { engineId: engineRef.current, at: Date.now(), ok: true, ms: took }
        : { engineId: engineRef.current, at: Date.now(), ok: false, problem: "failed", error: "Nothing was heard. Speak closer to the mic and try again." },
    );
  }, [stt, settle]);
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);

  const start = useCallback(async () => {
    if (phaseRef.current !== "idle" || !engineId) return;
    engineRef.current = engineId;
    setTranscript("");
    setMs(null);
    move("listening");
    try {
      const started = await stt.start();
      if (current() !== "listening") return;
      if (!started) {
        settle(failure(engineId, "The microphone did not start."));
        return;
      }
      timerRef.current = setTimeout(() => void stopRef.current(), LISTEN_TEST_MAX_MS);
    } catch (error) {
      if (current() === "listening") settle(failure(engineId, error));
    }
  }, [engineId, stt, settle]);

  const cancel = useCallback(() => {
    if (phaseRef.current === "idle") return;
    clearTimer();
    move("idle");
    stt.cancel();
  }, [stt]);

  useEffect(() => clearTimer, []);

  return { phase, interim: stt.interim, transcript, ms, start, stop, cancel };
}

export interface SpeakTest {
  playing: boolean;
  ms: number | null;
  run: (text: string, language?: string) => Promise<boolean>;
  stop: () => void;
}

/** Speak test: plays `text` through the active voice; resolves true when it played to the end. */
export function useSpeakTest(voice: Pick<VoiceFeedback, "preview" | "stopPreview">, engineId: string | null): SpeakTest {
  const [playing, setPlaying] = useState(false);
  const [ms, setMs] = useState<number | null>(null);
  const runRef = useRef(0);

  const run = useCallback(
    async (text: string, language?: string) => {
      if (!engineId) return false;
      const id = ++runRef.current;
      setPlaying(true);
      setMs(null);
      const startedAt = performance.now();
      try {
        await voice.preview(text, language ? { language } : undefined);
        if (runRef.current !== id) return false;
        const took = Math.round(performance.now() - startedAt);
        setMs(took);
        recordVoiceTest("speak", { engineId, at: Date.now(), ok: true, ms: took });
        return true;
      } catch (error) {
        if (runRef.current === id) recordVoiceTest("speak", failure(engineId, error));
        return false;
      } finally {
        if (runRef.current === id) setPlaying(false);
      }
    },
    [voice, engineId],
  );

  const stop = useCallback(() => {
    runRef.current += 1;
    voice.stopPreview();
    setPlaying(false);
  }, [voice]);

  return { playing, ms, run, stop };
}
