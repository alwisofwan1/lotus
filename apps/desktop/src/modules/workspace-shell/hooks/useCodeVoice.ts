"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSpeechToText } from "@/modules/voice-core/use-speech-to-text";
import { usePushToTalkSession } from "@/modules/voice-core/use-push-to-talk-session";
import type { PushToTalkHandlers, PushToTalkPhase } from "@/modules/voice-core/push-to-talk-session";
import { useVoiceHotkeyHandlers } from "@/modules/voice-core/voice-hotkey-context";
import type { VoiceHotkeyPressInfo } from "@/modules/voice-core/voice-hotkeys";
import { computeLevel, SPECTRUM_BAND_COUNT } from "@/modules/voice-core/spectrum-visual";
import { CANCELLED_DELIVERY_REASON, EMPTY_DELIVERY_REASON, type VoiceTurnTarget } from "@/modules/voice-core/voice-adapter";
import { useLotusSettings } from "@/modules/lotus-settings/lotus-settings-context";
import { nlComplete } from "@/lib/tauri-api";
import { getVoiceAccuracySettings } from "@/modules/codecanvas/hooks/useVoiceAccuracySettings";
import { getVoiceInputSettings } from "@/modules/codecanvas/hooks/useVoiceInputSettings";
import { CODE_VOICE_REVIEW_REASON, createCodeVoiceAdapter, type CodeVoiceAdapterDeps } from "../services/code-voice-adapter";
import {
  buildCodeVoiceDecoderContext,
  cleanUpCodeVoiceTranscript,
  finalizeCodeVoiceTranscript,
} from "../services/code-voice-transcript";
import { useVoiceKeyLabel } from "../components/composer-voice-parts";

export const CODE_VOICE_NO_PROVIDER = "Voice input needs a provider — set one up in Lotus Settings › Voice.";
export const CODE_VOICE_IGNORED = "Didn't catch that — try again.";
export const CODE_VOICE_CANCELLED = "Voice input cancelled.";
export const CODE_VOICE_CLEANUP_FAILED = "Couldn't clean up the text — this is what you said.";
export const CODE_VOICE_LIVE_NO_PROVIDER = "Live Voice needs a provider — enable one in Lotus Settings › Voice.";

/** The Live Voice session, as far as its button and key need it. */
export interface CodeVoiceLiveSession {
  available: boolean;
  active: boolean;
  start: () => Promise<void> | void;
  stop: () => void;
}

export interface CodeVoiceControls {
  phase: PushToTalkPhase;
  /** Live partial transcript while recording. */
  interim: string;
  /** The last thing voice has to tell the user (an error, or why the text was kept). */
  notice: string | null;
  /** Dictate button / hotkey: start recording, or stop and transcribe. `sendNow` ends the turn with
   *  ⌘Enter: it is sent right away, whatever Send Right Away says. */
  toggle: (options?: { sendNow?: boolean }) => void;
  cancel: () => void;
  /**
   * Ref callback for the element that draws the listening waveform. While recording, the live mic
   * level (0–1) is written to it as `--voice-level` and each spectrum band as `--voice-band-<n>` —
   * straight to the DOM, at the sampler's frame rate, never through React state.
   */
  levelTarget: (element: HTMLElement | null) => void;
  /** The Push-to-Talk key as printed ("⌥Space", "Alt+Space"), or null when it is unbound. */
  hotkeyLabel: string | null;
  /** The Live Voice key as printed ("⌘⇧L"), or null when it is unbound. */
  liveHotkeyLabel: string | null;
  /** False = no voice provider is set: the mic looks unavailable before it is clicked. */
  available: boolean;
  /** This turn began with the Push-to-Talk key held down: letting go finishes it. */
  held: boolean;
  /** The Live Voice button and key: start it, or end the session that runs. */
  startLiveVoice: () => void;
}

/**
 * Push-to-Talk in Code mode (plans/voice-core stories 24-27, 29-30): the Voice Core session, the
 * speech-to-text hook and the Code Voice Adapter, joined. While `live` (Code is the mode on screen
 * and hears the keyboard) it claims the app voice hotkeys — Push-to-Talk, and Live Voice when a
 * `liveVoice` session is given (Monaco loses ⌘⇧L then) — and Escape cancels a turn. One voice at a
 * time: opening the mic ends Live Voice, and starting Live Voice drops a turn being captured.
 */
export function useCodeVoice({
  live,
  deps,
  liveVoice,
}: {
  live: boolean;
  deps: CodeVoiceAdapterDeps;
  liveVoice?: CodeVoiceLiveSession;
}): CodeVoiceControls {
  const [notice, setNotice] = useState<string | null>(null);
  const { openSettings } = useLotusSettings();
  const levelTargetRef = useRef<HTMLElement | null>(null);
  const levelTarget = useCallback((element: HTMLElement | null) => {
    const previous = levelTargetRef.current;
    previous?.style.removeProperty("--voice-level");
    for (let band = 0; band < SPECTRUM_BAND_COUNT; band++) previous?.style.removeProperty(`--voice-band-${band}`);
    levelTargetRef.current = element;
  }, []);
  const onSpectrum = useCallback((bands: number[]) => {
    const target = levelTargetRef.current;
    if (!target) return;
    target.style.setProperty("--voice-level", computeLevel(bands).toFixed(3));
    // Each band for the composer's waveform. Square-rooted: speech rarely fills a band, and a linear
    // bar barely leaves the floor at conversational volume.
    bands.forEach((value, band) => target.style.setProperty(`--voice-band-${band}`, Math.sqrt(value).toFixed(3)));
  }, []);
  const stt = useSpeechToText({ onError: setNotice, onSpectrum });
  const hotkeyLabel = useVoiceKeyLabel("push-to-talk");
  const liveHotkeyLabel = useVoiceKeyLabel("live-voice");
  /** How this turn stops, for the listening row: held = let go of the key; otherwise press again. */
  const [held, setHeld] = useState(false);

  // Deps are fresh closures every render; a turn reads the latest when it delivers.
  const depsRef = useRef(deps);
  const liveVoiceRef = useRef(liveVoice);
  useEffect(() => {
    depsRef.current = deps;
    liveVoiceRef.current = liveVoice;
  });
  /** The Composer Target when this turn's mic opened, and whether it was ended with ⌘Enter. */
  const turnRef = useRef<{ target: VoiceTurnTarget | null; sendNow: boolean }>({ target: null, sendNow: false });
  /** The spoken text behind the cleaned transcript of the turn being delivered, for Undo. */
  const spokenRef = useRef<{ text: string; spoken: string } | null>(null);

  const handlers: PushToTalkHandlers = {
    async startMic() {
      setNotice(null);
      // Locked here, not at delivery: a turn goes where Enter would have gone when it began (ADR-0064).
      turnRef.current = { target: depsRef.current.focused(), sendNow: false };
      if (liveVoiceRef.current?.active) liveVoiceRef.current.stop();
      if (!stt.available) {
        setNotice(CODE_VOICE_NO_PROVIDER);
        openSettings({ from: "dictate" });
        return false;
      }
      // Snapshotted at mic start, like Canvas: the turn is decoded with the names on screen when it began.
      const paneNames = depsRef.current.getPanes().map((pane) => pane.name);
      return stt.start(buildCodeVoiceDecoderContext(getVoiceAccuracySettings(), paneNames));
    },
    async finishMic(turn) {
      spokenRef.current = null;
      const raw = await stt.stop();
      const accuracy = getVoiceAccuracySettings();
      const input = getVoiceInputSettings();
      if (!input.autoCleanup || !raw.trim()) return finalizeCodeVoiceTranscript(raw, accuracy);
      let failed = false;
      const result = await cleanUpCodeVoiceTranscript(raw, {
        accuracy,
        paneNames: depsRef.current.getPanes().map((pane) => pane.name),
        mode: input.dictationMode,
        signal: turn.signal,
        callModel: (prompt, signal) =>
          nlComplete(prompt, undefined, signal).catch((error: unknown) => {
            if (!signal?.aborted) failed = true;
            throw error;
          }),
      });
      if (!turn.isCurrent()) return result.text;
      if (failed) setNotice(CODE_VOICE_CLEANUP_FAILED);
      if (result.text !== result.spoken) spokenRef.current = result;
      return result.text;
    },
    cancelMic: () => stt.cancel(),
    async deliver(text, turn, source) {
      const cleaned = source === "voice" && spokenRef.current?.text === text.trim() ? spokenRef.current : null;
      spokenRef.current = null;
      const adapterDeps: CodeVoiceAdapterDeps = cleaned
        ? {
            ...depsRef.current,
            holdInComposer: (held, _spoken, ...keptFor) => depsRef.current.holdInComposer(held, cleaned.spoken, ...keptFor),
            prompt: (held, route, target) => depsRef.current.prompt(held, route, target, cleaned.spoken),
          }
        : depsRef.current;
      const { target, sendNow } = turnRef.current;
      const result = await createCodeVoiceAdapter(adapterDeps).deliver(
        text,
        source === "voice" ? { source, signal: turn.signal, target, sendNow } : { source, signal: turn.signal },
      );
      if (!turn.isCurrent()) return;
      if (result.status === "failed" && result.reason !== CANCELLED_DELIVERY_REASON) throw new Error(result.reason);
      if (result.status === "held" && result.reason !== CODE_VOICE_REVIEW_REASON && result.reason !== EMPTY_DELIVERY_REASON) {
        setNotice(result.reason);
      }
    },
    report(kind, message) {
      setNotice(kind === "ignored" ? CODE_VOICE_IGNORED : kind === "cancelled" ? CODE_VOICE_CANCELLED : (message ?? "Voice input failed."));
    },
  };
  const ptt = usePushToTalkSession(handlers);

  const toggle = useCallback(
    (options?: { sendNow?: boolean }) => {
      if (options?.sendNow) turnRef.current = { ...turnRef.current, sendNow: true };
      setHeld(false);
      ptt.press();
    },
    [ptt],
  );
  const keyPress = useCallback(
    (press?: VoiceHotkeyPressInfo) => {
      // Only a press that opens the mic says how its turn stops; one that stops a turn says nothing.
      const phase = ptt.getPhase();
      if (phase !== "starting" && phase !== "recording") setHeld(Boolean(press?.holding));
      ptt.press();
    },
    [ptt],
  );
  const release = useCallback(() => {
    setHeld(false);
    ptt.release();
  }, [ptt]);
  const tapped = useCallback(() => setHeld(false), []);
  const cancel = useCallback(() => ptt.cancel(), [ptt]);
  const startLiveVoice = useCallback(() => {
    const session = liveVoiceRef.current;
    if (!session) return;
    if (!session.available) {
      setNotice(CODE_VOICE_LIVE_NO_PROVIDER);
      openSettings({ from: "dictate" });
    } else if (session.active) session.stop();
    else {
      const phase = ptt.getPhase();
      if (phase === "starting" || phase === "recording" || phase === "transcribing") ptt.cancel();
      setNotice(null);
      void session.start();
    }
  }, [openSettings, ptt]);

  useVoiceHotkeyHandlers(
    live
      ? { pushToTalk: keyPress, pushToTalkRelease: release, pushToTalkTap: tapped, ...(liveVoice ? { liveVoice: startLiveVoice } : {}) }
      : {},
  );

  // A stale last frame must not leave the edge lit once capture ends.
  useEffect(() => {
    if (stt.recording) return;
    levelTargetRef.current?.style.removeProperty("--voice-level");
  }, [stt.recording]);

  // Escape drops a turn that is still capturing or transcribing — and only then, so a terminal keeps
  // its own Escape the rest of the time. ⌘Enter while recording finishes the turn and sends it.
  const capturing = ptt.phase === "starting" || ptt.phase === "recording" || ptt.phase === "transcribing";
  const recording = ptt.phase === "recording";
  useEffect(() => {
    if (!live || !capturing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && recording) {
        event.preventDefault();
        event.stopPropagation();
        toggle({ sendNow: true });
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cancel, capturing, live, recording, toggle]);

  return {
    phase: ptt.phase,
    interim: stt.interim,
    notice,
    toggle,
    cancel,
    levelTarget,
    hotkeyLabel,
    liveHotkeyLabel,
    // Not "unavailable" while the provider list is still loading: that would flash on every mount.
    available: stt.available || Boolean(stt.checking),
    held,
    startLiveVoice,
  };
}
