"use client";
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Node } from "@xyflow/react";
import { useSpeechToText } from "@/modules/voice-core/use-speech-to-text";
import type { VoiceOutcome } from "./voice-intent-router";
import { getVoiceInputSettings } from "../../hooks/useVoiceInputSettings";
import { getVoiceAccuracySettings } from "../../hooks/useVoiceAccuracySettings";
import { useCanvasHotkeys } from "../../hooks/useCanvasHotkeys";
import { useVoiceHotkeyHandlers } from "@/modules/voice-core/voice-hotkey-context";
import { useLotusSettings } from "@/modules/lotus-settings/lotus-settings-context";
import { createLatencyTrace } from "../nl-latency";
import { buildCanvasVoiceContextFromNodes } from "./canvas-voice-node-context";
import type { CanvasVoiceContext } from "./canvas-voice-context";
import { agentStatusRegistry } from "../agent-status-registry";
import type { VoiceMode } from "./voice-mode";
import type { SttCaptureMode, SttDecoderContext } from "./stt-hint";
import type { CommandBarLiveVoice } from "./use-command-bar-live-voice";
import type { SpeechGate } from "@/modules/voice-core/speech-gate";
import type { CanvasNlSubmitOptions } from "./use-canvas-nl-command-controller";
import type { VoiceLiveTools, VoiceTurnTarget } from "@/modules/voice-core/voice-adapter";
import type { VoiceHotkeyPressInfo } from "@/modules/voice-core/voice-hotkeys";
import {
  createCanvasVoiceAdapter,
  type CanvasVoiceAdapter,
  type DictationDeliveryState,
  type DictationDispatchOptions,
  type DictationDispatchResult,
} from "./canvas-voice-adapter";
import { applyVoiceReplacements } from "./voice-replacements";
import {
  createVoiceTurnId,
  recordVoiceTurnDiagnostic,
  updateVoiceTurnDiagnostic,
  type VoiceTurnMilestone,
  type VoiceTurnMilestoneName,
  type VoiceTurnRoute,
} from "./voice-turn-diagnostics";
import { assessTranscriptLanguageIntegrity, languageMismatchMessage } from "./transcript-language-integrity";
import { usePushToTalkSession } from "@/modules/voice-core/use-push-to-talk-session";
import type { PushToTalkHandlers, PushToTalkPhase, PushToTalkTurn } from "@/modules/voice-core/push-to-talk-session";
import { waitForClassicVoiceStage } from "./classic-voice-stage-deadline";
import { useCanvasHeldPrompt, type CanvasHeldPrompt, type CanvasHeldPromptOutcome } from "./use-canvas-held-prompt";

const MAX_RECORDING_MS = 30_000;
const MIN_CAPTURE_SPECTRUM_FRAMES = 10;
const SPEECH_LIKE_SPECTRUM_LEVEL = 0.025;
export const CLASSIC_STT_FINALIZATION_TIMEOUT_MS = 8_000;

type Trace = { text: string; tone: "ok" | "error" };

type SpeechToTextHandle = ReturnType<typeof useSpeechToText>;

export interface CanvasTurnVoiceControllerOptions {
  nodes: Node[];
  busy: boolean;
  live: CommandBarLiveVoice;
  speechGate: SpeechGate;
  setTrace: (trace: Trace) => void;
  /** What the bar holds right now. */
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  focusInput: () => void;
  hasCommandVerb: (query: string) => boolean;
  /** Automatic dictation cleanup (Voice › Advanced). Fails open to the text it was given. */
  cleanUpDictation?: (text: string, signal?: AbortSignal) => Promise<string>;
  submitQuery: (query: string, options?: CanvasNlSubmitOptions) => Promise<boolean>;
  dispatchDictation: (
    agentId: string,
    agentName: string,
    text: string,
    opts: DictationDispatchOptions,
  ) => Promise<DictationDispatchResult>;
  /** Raw input for an agent's prompt: where a Held Prompt is placed, sent and cleared. */
  writeAgentPrompt?: (agentId: string, data: string) => boolean;
  /** Inserts literal text into a focused plain Terminal node without submitting it. */
  insertTerminalDictation?: (nodeId: string, text: string) => boolean;
  /** Submits literal text to a focused plain Terminal. Resolves true once its receipt says written. */
  submitTerminal?: (
    nodeId: string,
    nodeName: string,
    text: string,
    options?: { signal?: AbortSignal },
  ) => Promise<boolean | void> | boolean | void;
  /** Rewrites a note selection. Resolves true when the note changed. */
  runTransform: (nodeId: string, instruction: string, selection: string, signal?: AbortSignal) => Promise<boolean | void>;
  /** Live Voice tools, exposed on the adapter. */
  liveTools?: VoiceLiveTools;
  getDecoderContext: (mode: SttCaptureMode) => SttDecoderContext;
  onSpectrum: (bands: number[]) => void;
}

export interface CanvasCaptureRoute {
  context: CanvasVoiceContext;
  forcedMode: VoiceMode | null;
}

export interface CanvasTurnVoiceController {
  /** The Canvas Voice Adapter every typed and spoken turn is delivered through. */
  adapter: CanvasVoiceAdapter;
  stt: SpeechToTextHandle;
  /** Where the spoken turn is: what the bar's voice slot and listening row draw. A typed Enter runs
   *  through the same session, but its delivery is not a voice phase and reads idle here. */
  phase: PushToTalkPhase;
  /** This turn began with the Push-to-Talk key held down: letting go finishes it. Otherwise tapped. */
  held: boolean;
  /** A spoken message waiting, unsent, in an Agent Node's prompt. */
  heldPrompt: CanvasHeldPrompt | null;
  /** The open capture's mic-open snapshot: the bar reads its Composer Target from this rather than
   *  from focus now, since the turn goes where focus was when the mic opened. Null with no capture. */
  captureRoute: CanvasCaptureRoute | null;
  /** The node text kept in the bar was spoken to: typed Enter sends it there, whatever has focus. */
  keptFor: VoiceTurnTarget | null;
  beginVoice: (forced?: VoiceMode) => Promise<void>;
  cancelRecording: () => void;
  /** A Push-to-Talk turn is open (mic, transcription, or a delivery still running): Escape cancels it. */
  turnLive: boolean;
  /** The open turn is still on the voice side (mic or transcription), not a delivery. */
  voiceOpen: boolean;
  /** Typed Enter through the session's in-flight guard. False = refused (a turn is in flight). */
  submitTyped: (text: string) => boolean;
  /** Enter in the empty bar: send the Held Prompt. */
  sendHeldPrompt: () => CanvasHeldPromptOutcome;
  /** Escape in the bar: clear the Held Prompt from the agent's prompt. */
  clearHeldPrompt: () => CanvasHeldPromptOutcome;
  onMic: () => void;
  /** The Live Voice button and ⌘⇧L: start Canvas Live Voice, or end the running session. */
  toggleLive: () => void;
}

/** Stop-to-delivery milestones of one spoken turn, in monotonic elapsed ms from mic stop. */
interface TurnClock {
  turnId: string;
  startedAt: number;
  milestones: VoiceTurnMilestone[];
  mark: (name: VoiceTurnMilestoneName) => void;
  last: () => number;
}

function createTurnClock(turnId: string): TurnClock {
  const startedAt = performance.now();
  const milestones: VoiceTurnMilestone[] = [];
  let lastMs = 0;
  const mark = (name: VoiceTurnMilestoneName) => {
    lastMs = Math.max(lastMs, Math.round(performance.now() - startedAt));
    milestones.push({ name, elapsedMs: lastMs });
  };
  mark("mic_stop");
  return { turnId, startedAt, milestones, mark, last: () => lastMs };
}

/** Turn a getUserMedia/provider failure into an actionable message for the command bar. */
export function describeMicError(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err;
  const name = typeof err === "object" && err !== null && "name" in err ? String((err as { name: unknown }).name) : "";
  const message = typeof err === "object" && err !== null && "message" in err ? String((err as { message: unknown }).message) : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone permission denied — allow it in System Settings → Privacy & Security → Microphone, then reopen Lotus.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone was found.";
    case "NotReadableError":
    case "AbortError":
      return "The microphone is busy in another app.";
    case "TypeError":
      return "Microphone capture isn't available in this window.";
    default:
      return message || "Microphone unavailable.";
  }
}

export function useCanvasTurnVoiceController({
  nodes,
  busy,
  live,
  speechGate,
  setTrace,
  text,
  setText,
  focusInput,
  hasCommandVerb,
  cleanUpDictation,
  submitQuery,
  dispatchDictation,
  writeAgentPrompt,
  insertTerminalDictation,
  submitTerminal,
  runTransform,
  liveTools,
  getDecoderContext,
  onSpectrum,
}: CanvasTurnVoiceControllerOptions): CanvasTurnVoiceController {
  const recordTimerRef = useRef<number | null>(null);
  /** The capture mode a `beginVoice(forced)` asked for, read when the session opens the mic. */
  const pendingForcedModeRef = useRef<VoiceMode | null>(null);
  /** Stop-to-delivery timing of the turn being finished; created when the mic stops. */
  const turnClockRef = useRef<TurnClock | null>(null);
  const heldPrompt = useCanvasHeldPrompt({ nodes, writeAgentPrompt });
  const textRef = useRef(text);
  /** The node a turn kept in the bar was spoken to: the next typed Enter goes there (ADR-0064). */
  const keptForRef = useRef<VoiceTurnTarget | null>(null);
  // The same, for the bar to draw: its Composer Target names this node while the text waits.
  const [keptFor, setKeptFor] = useState<VoiceTurnTarget | null>(null);
  const keepFor = (target: VoiceTurnTarget | null) => {
    keptForRef.current = target;
    setKeptFor(target);
  };
  useEffect(() => {
    textRef.current = text;
    // An emptied bar has nothing left to keep for anyone.
    if (!text.trim()) keptForRef.current = null;
  }, [text]);
  // Rebuilt every render on purpose: it reads the latest nodes and routes, and holds no state.
  const adapter: CanvasVoiceAdapter = createCanvasVoiceAdapter({
    getNodes: () => nodes,
    getRoster: () => agentStatusRegistry.list(),
    getInputSettings: getVoiceInputSettings,
    hasCommandVerb,
    routes: {
      command: (text, options) => submitQuery(text, options),
      dictate: async (agentId, agentName, text, options) => {
        // A message for the agent holding a Held Prompt is sent with it, as one, and says so.
        const joined = heldPrompt.join(agentId);
        const result = await dispatchDictation(agentId, agentName, text, options);
        if (joined && result.delivery !== "failed") {
          setTrace({ text: `Sent together with the text waiting in ${joined}'s prompt.`, tone: "ok" });
        }
        return result;
      },
      insertAgent: (agentId, agentName, text) => heldPrompt.place(agentId, agentName, text),
      insertTerminal: (nodeId, text) => insertTerminalDictation?.(nodeId, text) ?? false,
      submitTerminal: async (nodeId, nodeName, text, options) =>
        (await submitTerminal?.(nodeId, nodeName, text, options)) !== false,
      transform: async (nodeId, instruction, selection, signal) =>
        (await runTransform(nodeId, instruction, selection, signal)) !== false,
    },
    ui: {
      setText,
      focusInput,
      setTrace,
      hasText: () => textRef.current.trim() !== "",
      keepFor,
      interruptSpeech: () => speechGate.interrupt(),
    },
    liveTools,
  });
  const captureForcedModeRef = useRef<VoiceMode | null>(null);
  const captureVoiceContextRef = useRef<CanvasVoiceContext | null>(null);
  /** The Composer Target when the mic opened: the turn goes there whatever has focus later. */
  const captureTargetRef = useRef<VoiceTurnTarget | null>(null);
  /** This turn was ended with ⌘Enter: it is sent right away, whatever Send Right Away says. */
  const sendNowRef = useRef(false);
  /** How this turn stops, for the listening row: held = let go of the key; otherwise press again. */
  const [held, setHeld] = useState(false);
  /** The turn in flight came from typed Enter, not the mic. */
  const [typedTurn, setTypedTurn] = useState(false);
  // The one piece of capture state the UI renders, so it IS React state (the refs above are read-only
  // bookkeeping consumed at finalize time and must never repaint the bar mid-capture).
  const [captureRoute, setCaptureRoute] = useState<CanvasCaptureRoute | null>(null);
  const captureAudioQualityRef = useRef({ frames: 0, peak: 0, startedAt: 0 });
  const handleSpectrum = useCallback((bands: number[]) => {
    const level = bands.length > 0 ? bands.reduce((sum, value) => sum + Math.max(0, value), 0) / bands.length : 0;
    captureAudioQualityRef.current.frames += 1;
    captureAudioQualityRef.current.peak = Math.max(captureAudioQualityRef.current.peak, level);
    onSpectrum(bands);
  }, [onSpectrum]);
  const stt = useSpeechToText({ onError: (msg) => setTrace({ text: msg, tone: "error" }), onSpectrum: handleSpectrum });
  const { openSettings } = useLotusSettings();

  const clearCapture = useCallback(() => {
    captureForcedModeRef.current = null;
    captureVoiceContextRef.current = null;
    captureTargetRef.current = null;
    setCaptureRoute(null);
    captureAudioQualityRef.current = { frames: 0, peak: 0, startedAt: 0 };
  }, []);

  const clearRecordTimer = useCallback(() => {
    if (recordTimerRef.current !== null) {
      window.clearTimeout(recordTimerRef.current);
      recordTimerRef.current = null;
    }
  }, []);

  // The session opens the mic for a new turn. Resolves false when it did not open (no provider, or
  // the turn was superseded meanwhile); throws a mic error the session reports via describeMicError.
  const startMic = async (turn: PushToTalkTurn): Promise<boolean> => {
    const captureMode = pendingForcedModeRef.current;
    pendingForcedModeRef.current = null;
    captureAudioQualityRef.current = { frames: 0, peak: 0, startedAt: performance.now() };
    sendNowRef.current = false;
    setTypedTurn(false);
    const captureVoiceContext = buildCanvasVoiceContextFromNodes(nodes, agentStatusRegistry.list());
    captureForcedModeRef.current = captureMode;
    captureVoiceContextRef.current = captureVoiceContext;
    const focus = captureVoiceContext.focus;
    captureTargetRef.current = focus ? { id: focus.nodeId, name: focus.name } : null;
    // Published before the mic actually opens: `starting` is already visible in the bar, and its
    // Composer Target must not name one target and then flip to another.
    setCaptureRoute({ context: captureVoiceContext, forcedMode: captureMode });
    try {
      if (live.active) live.stop();
      speechGate.interrupt();
      const decoderMode: SttCaptureMode = captureMode ?? (focus?.selectedText ? "transform" : "auto");
      const started = await stt.start(getDecoderContext(decoderMode));
      if (!turn.isCurrent()) {
        stt.cancel();
        return false;
      }
      if (!started) {
        clearCapture();
        return false;
      }
      // Where the words go is the Composer Target's to say; this line only says the mic is open.
      setTrace({ text: "Listening… Esc to cancel.", tone: "ok" });
      recordTimerRef.current = window.setTimeout(() => ptt.release(), MAX_RECORDING_MS);
      return true;
    } catch (err) {
      if (turn.isCurrent()) {
        clearCapture();
        console.warn("[voice] mic start failed:", err);
      }
      throw err;
    }
  };

  // The session stops the mic: finalize STT, bounded so a wedged provider cannot hold the turn.
  const finishMic = async (turn: PushToTalkTurn): Promise<string> => {
    clearRecordTimer();
    turnClockRef.current = createTurnClock(createVoiceTurnId());
    setTrace({ text: stt.interim.trim() ? `Transcribing “${stt.interim.trim()}”…` : "Transcribing…", tone: "ok" });
    try {
      return await waitForClassicVoiceStage(stt.stop(), {
        stage: "STT finalization",
        timeoutMs: CLASSIC_STT_FINALIZATION_TIMEOUT_MS,
        signal: turn.signal,
      });
    } catch (err) {
      if (turn.isCurrent()) {
        stt.cancel();
        clearCapture();
      }
      throw err;
    }
  };

  // The session hands over a non-empty transcript: guard capture quality and language, then route.
  const deliverVoice = async (transcriptText: string, turn: PushToTalkTurn): Promise<void> => {
    const clock = turnClockRef.current ?? createTurnClock(createVoiceTurnId());
    turnClockRef.current = null;
    const voiceLat = createLatencyTrace();
    const { turnId, startedAt: transcriptionStartedAt, milestones } = clock;
    const markMilestone = clock.mark;
    let transcript = transcriptText;
    const transcriptionMs = Math.max(0, Math.round(performance.now() - transcriptionStartedAt));
    markMilestone("stt_final");
    voiceLat.mark("stt-final");
    const rawTranscript = transcript;
    const audioQuality = captureAudioQualityRef.current;
    captureAudioQualityRef.current = { frames: 0, peak: 0, startedAt: 0 };
    if (
      rawTranscript.trim()
      && audioQuality.frames >= MIN_CAPTURE_SPECTRUM_FRAMES
      && audioQuality.peak < SPEECH_LIKE_SPECTRUM_LEVEL
    ) {
      captureForcedModeRef.current = null;
      captureVoiceContextRef.current = null;
      setCaptureRoute(null);
      const metadata = stt.getLastTurnMetadata?.();
      const captureMs = audioQuality.startedAt > 0
        ? Math.max(0, Math.round(transcriptionStartedAt - audioQuality.startedAt))
        : 0;
      markMilestone("held_for_review");
      markMilestone("turn_complete");
      recordVoiceTurnDiagnostic({
        turnId,
        provider: metadata?.provider ?? "unknown",
        model: metadata?.model,
        requestedLanguages: metadata?.requestedLanguages ?? [],
        detectedLanguages: metadata?.detectedLanguages ?? [],
        rawTranscript,
        replacementTranscript: rawTranscript,
        finalTranscript: rawTranscript.trim(),
        route: "insert",
        captureQuality: "low-speech",
        spectrumFrames: audioQuality.frames,
        peakSpectrumLevel: audioQuality.peak,
        latencyMs: {
          capture: captureMs,
          transcription: transcriptionMs,
          total: Math.max(transcriptionMs, clock.last()),
        },
        milestones,
      });
      setText(rawTranscript.trim());
      focusInput();
      setTrace({ text: "Detected little or no speech — transcript kept for review and was not submitted.", tone: "error" });
      return;
    }
    const metadata = stt.getLastTurnMetadata?.();
    const languageIntegrity = assessTranscriptLanguageIntegrity({
      text: rawTranscript,
      requestedLanguages: metadata?.requestedLanguages ?? [],
      detectedLanguages: metadata?.detectedLanguages ?? [],
    });
    if (languageIntegrity === "mismatch") {
      captureForcedModeRef.current = null;
      captureVoiceContextRef.current = null;
      setCaptureRoute(null);
      markMilestone("held_for_review");
      markMilestone("turn_complete");
      recordVoiceTurnDiagnostic({
        turnId,
        provider: metadata?.provider ?? "unknown",
        model: metadata?.model,
        requestedLanguages: metadata?.requestedLanguages ?? [],
        detectedLanguages: metadata?.detectedLanguages ?? [],
        rawTranscript,
        replacementTranscript: rawTranscript,
        finalTranscript: rawTranscript.trim(),
        route: "insert",
        languageIntegrity,
        latencyMs: {
          transcription: transcriptionMs,
          total: Math.max(transcriptionMs, clock.last()),
        },
        milestones,
      });
      setText(rawTranscript.trim());
      focusInput();
      setTrace({
        text: languageMismatchMessage(metadata?.requestedLanguages ?? []),
        tone: "error",
      });
      return;
    }
    transcript = applyVoiceReplacements(
      transcript,
      getVoiceAccuracySettings().replacements,
      "before-ai",
    );
    const turnForcedMode = captureForcedModeRef.current;
    const turnVoiceContext = captureVoiceContextRef.current
      ?? buildCanvasVoiceContextFromNodes(nodes, agentStatusRegistry.list());
    // Only with the context it came from: a turn without a mic-open snapshot has no locked target.
    const turnTarget = captureVoiceContextRef.current ? captureTargetRef.current : undefined;
    const sendNow = sendNowRef.current;
    sendNowRef.current = false;
    captureForcedModeRef.current = null;
    captureVoiceContextRef.current = null;
    captureTargetRef.current = null;
    setCaptureRoute(null);
    const diagnostic = {
      turnId,
      provider: metadata?.provider ?? "unknown",
      model: metadata?.model,
      requestedLanguages: metadata?.requestedLanguages ?? [],
      detectedLanguages: metadata?.detectedLanguages ?? [],
      rawTranscript,
      replacementTranscript: transcript,
      route: "empty" as VoiceTurnRoute,
      languageIntegrity,
      latencyMs: {
        transcription: transcriptionMs,
        total: Math.max(transcriptionMs, Math.round(performance.now() - transcriptionStartedAt)),
      },
      milestones,
    };
    const currentLatency = () => {
      const polishStartedAt = milestones.find((milestone) => milestone.name === "polish_started")?.elapsedMs;
      const polishFinishedAt = milestones.find((milestone) => milestone.name === "polish_finished")?.elapsedMs;
      const polishMs = polishStartedAt !== undefined && polishFinishedAt !== undefined
        ? Math.max(0, polishFinishedAt - polishStartedAt)
        : undefined;
      const enterWrittenAt = milestones.find((milestone) => milestone.name === "pty_enter_written")?.elapsedMs;
      const firstOutputAt = milestones.find((milestone) => milestone.name === "agent_first_output")?.elapsedMs;
      const agentFirstOutputMs = enterWrittenAt !== undefined && firstOutputAt !== undefined
        ? Math.max(0, firstOutputAt - enterWrittenAt)
        : undefined;
      return {
        ...diagnostic.latencyMs,
        ...(polishMs !== undefined ? { polish: polishMs } : {}),
        ...(agentFirstOutputMs !== undefined ? { agentFirstOutput: agentFirstOutputMs } : {}),
        total: Math.max(transcriptionMs, clock.last()),
      };
    };
    const recordDiagnostic = (
      finalTranscript: string,
      polishedTranscript?: string,
      delivery?: DictationDeliveryState,
    ) => {
      recordVoiceTurnDiagnostic({
        ...diagnostic,
        ...(polishedTranscript ? { polishedTranscript } : {}),
        ...(delivery ? { delivery } : {}),
        finalTranscript,
        latencyMs: currentLatency(),
      });
    };

    // Auto-sent dictation: its milestones arrive as the write and the agent's first output land.
    let requested = false;
    let accepted = false;
    let enterWritten = false;
    let turnCompleted = false;
    let diagnosticRecorded = false;
    const syncAsyncMilestones = () => {
      if (!diagnosticRecorded) return;
      updateVoiceTurnDiagnostic(turnId, { latencyMs: currentLatency(), milestones });
    };
    const markEnterWritten = () => {
      if (enterWritten) return;
      enterWritten = true;
      markMilestone("pty_enter_written");
    };
    const completeAgentTurn = (firstOutput: boolean) => {
      if (turnCompleted) return;
      if (firstOutput) {
        markEnterWritten();
        markMilestone("agent_first_output");
      }
      markMilestone("turn_complete");
      turnCompleted = true;
      syncAsyncMilestones();
    };

    let routedOutcome: VoiceOutcome | null = null;
    const result = await adapter.deliver(transcript, {
      source: "voice",
      forced: turnForcedMode ?? undefined,
      signal: turn.signal,
      voiceContext: turnVoiceContext,
      target: turnTarget,
      ...(sendNow ? { sendNow } : {}),
      rewriteDictation: (text, signal) => {
        const afterAi = (value: string) =>
          applyVoiceReplacements(value, getVoiceAccuracySettings().replacements, "after-ai");
        if (!cleanUpDictation || !getVoiceInputSettings().autoCleanup) return afterAi(text);
        markMilestone("polish_started");
        return cleanUpDictation(text, signal).then((cleaned) => {
          markMilestone("polish_finished");
          return afterAi(cleaned);
        });
      },
      onRouted: (outcome) => {
        routedOutcome = outcome;
        diagnostic.route = outcome.kind === "ignore"
          ? "empty"
          : outcome.kind === "terminal-insert"
            ? "insert"
            : outcome.kind as VoiceTurnRoute;
        voiceLat.mark(`route:${outcome.kind}`);
      },
      turn: {
        turnId,
        mark: markMilestone,
        record: recordDiagnostic,
        dictation: {
          onStage: (stage) => {
            if (stage === "requested" && !requested) {
              requested = true;
              markMilestone("delivery_requested");
            } else if ((stage === "accepted" || stage === "queued") && !accepted) {
              accepted = true;
              markMilestone("delivery_accepted");
            } else if (stage === "written") {
              markEnterWritten();
            }
          },
          onAgentFirstOutput: () => completeAgentTurn(true),
          onAgentFirstOutputTimeout: () => completeAgentTurn(false),
        },
      },
    });
    const outcome = routedOutcome as VoiceOutcome | null;
    if (outcome?.kind === "dictate" && outcome.autoSend && turn.isCurrent()) {
      if (!requested) markMilestone("delivery_requested");
      if (result.delivery !== "failed" && !accepted) markMilestone("delivery_accepted");
      if (result.delivery === "written") markEnterWritten();
      else completeAgentTurn(false);
      recordDiagnostic(result.text, result.text === outcome.text ? undefined : result.text, result.delivery);
      diagnosticRecorded = true;
    }
    console.info(voiceLat.summary());
  };

  const handlers: PushToTalkHandlers = {
    startMic,
    finishMic,
    cancelMic: () => stt.cancel(),
    deliver: async (text, turn, source) => {
      if (source === "typed") {
        const target = keptForRef.current ?? undefined;
        keepFor(null);
        await adapter.deliver(text, { source: "typed", signal: turn.signal, target });
      }
      else await deliverVoice(text, turn);
    },
    report: (kind, message) => {
      clearRecordTimer();
      clearCapture();
      if (kind === "cancelled") setTrace({ text: "Voice input cancelled.", tone: "error" });
      else if (kind === "ignored") setTrace({ text: "Didn't catch that — try again.", tone: "error" });
      else setTrace({ text: message ?? "Voice input failed.", tone: "error" });
    },
    describeError: (err, stage) => (stage === "mic" ? describeMicError(err) : undefined),
  };
  const ptt = usePushToTalkSession(handlers);

  const cancelRecording = useCallback(() => {
    clearRecordTimer();
    if (ptt.getPhase() !== "idle") {
      ptt.cancel(); // closes the mic, aborts the turn (its late result never applies), reports "cancelled"
      return;
    }
    clearCapture();
    stt.cancel();
    setTrace({ text: "Voice input cancelled.", tone: "error" });
  }, [clearCapture, clearRecordTimer, ptt, setTrace, stt]);

  // Mic button / hotkey. The session decides: open the mic, stop and transcribe, or supersede a turn
  // that is still transcribing or delivering (its late result never applies).
  const beginVoice = useCallback(
    async (forced?: VoiceMode) => {
      if (busy || stt.starting) return;
      const recording = ptt.getPhase() === "recording";
      if (!recording && !stt.available) {
        setTrace({ text: "Voice input needs a provider — enable one in Settings → Voice.", tone: "error" });
        openSettings({ from: "dictate" }); // land on setup, not just a hint about where it is
        return;
      }
      if (!recording) pendingForcedModeRef.current = forced ?? null;
      ptt.press();
      await ptt.settled();
    },
    [busy, openSettings, ptt, setTrace, stt],
  );

  const submitTyped = useCallback((text: string) => {
    const accepted = ptt.submit(text);
    if (accepted) setTypedTurn(true);
    return accepted;
  }, [ptt]);

  // A click on the mic is a tap: the turn stops with another press, not a release.
  const onMic = useCallback(() => {
    if (ptt.getPhase() === "idle") setHeld(false);
    void beginVoice();
  }, [beginVoice, ptt]);
  // Only a press that opens the mic says how its turn stops; one that stops a turn says nothing.
  const keyPress = useCallback(
    (press?: VoiceHotkeyPressInfo) => {
      const phase = ptt.getPhase();
      if (phase !== "starting" && phase !== "recording") setHeld(Boolean(press?.holding));
      void beginVoice();
    },
    [beginVoice, ptt],
  );
  const release = useCallback(() => {
    setHeld(false);
    ptt.release();
  }, [ptt]);
  const tapped = useCallback(() => setHeld(false), []);

  useCanvasHotkeys({
    "voice-command": () => void beginVoice("command"),
    "voice-dictate": () => void beginVoice("dictate"),
  });

  // The app-level keys (Voice Core). Canvas has both actions; the chords live in the app voice store.
  const toggleLive = useCallback(() => {
    if (!live.available) {
      setTrace({ text: "Live Voice needs a provider — enable one in Settings → Voice.", tone: "error" });
      openSettings({ from: "dictate" });
    } else if (live.active) live.stop();
    else {
      if (stt.recording || stt.starting || stt.transcribing) cancelRecording();
      void live.start();
    }
  }, [cancelRecording, live, openSettings, setTrace, stt.recording, stt.starting, stt.transcribing]);
  useVoiceHotkeyHandlers({ pushToTalk: keyPress, pushToTalkRelease: release, pushToTalkTap: tapped, liveVoice: toggleLive });

  useEffect(() => {
    if (!stt.recording) clearRecordTimer();
    return () => clearRecordTimer();
  }, [clearRecordTimer, stt.recording]);

  // Escape must cancel an in-flight capture from ANYWHERE, not just from the command bar.
  //
  // The bubble-phase listener below can't do it: xterm cancels every key it handles
  // (`Terminal.cancel` → `preventDefault()` + `stopPropagation()`), and Escape is one of them — it
  // writes \x1b to the PTY. So while a terminal has DOM focus the event dies before it reaches
  // window, and that is precisely the common case: dictating means an agent node is focused, and a
  // focused agent node means its xterm holds the caret. Capture phase on window runs before xterm's
  // own handler, which is the only place early enough to win.
  //
  // This deliberately overrides the canvas rule that "the terminal keeps its own Esc"
  // (see shouldDispatchCanvasHotkey) — but only for the seconds a capture is actually open, and only
  // because the mic is a modal state the user just entered with no other keyboard exit. The listener
  // is ARMED, not permanent: while no capture is in flight it isn't attached at all, so a terminal's
  // Escape is untouched the rest of the time.
  //
  // A long-lived Live Voice session is deliberately NOT handled here — it can run for minutes, and
  // stealing Escape from vim for that long is not a trade worth making. It stays on the bubble
  // listener below, where a terminal still keeps its own Escape.
  // A Push-to-Talk turn is live from mic open until its delivery settles. Escape cancels it.
  const turnLive = ptt.phase !== "idle" || stt.recording || stt.starting;
  const capturing = ptt.phase === "starting" || ptt.phase === "recording" || ptt.phase === "transcribing";
  const capturingNow = capturing || stt.recording || stt.starting;
  // A typed Enter's delivery is not a voice phase: the bar's listening row stays out of it.
  const voicePhase: PushToTalkPhase = typedTurn && ptt.phase === "delivering" ? "idle" : ptt.phase;
  const recordingNow = ptt.phase === "recording";
  useEffect(() => {
    if (!capturingNow) return;
    const onEscapeCapture = (event: KeyboardEvent) => {
      // ⌘Enter (Ctrl+Enter off the Mac) while recording finishes the turn and sends it.
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && recordingNow) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        sendNowRef.current = true;
        void beginVoice();
        return;
      }
      if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      // stopImmediatePropagation as well: other window-capture listeners (the canvas hotkey
      // dispatcher) resolve Escape to `exit-layer` and would blur whatever the user focused.
      event.stopPropagation();
      event.stopImmediatePropagation();
      cancelRecording();
    };
    window.addEventListener("keydown", onEscapeCapture, { capture: true });
    return () => window.removeEventListener("keydown", onEscapeCapture, { capture: true });
  }, [beginVoice, cancelRecording, capturingNow, recordingNow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape" && !mod && !e.altKey) {
        // Bare Escape only — ⌘/⌃/⌥+Escape are chords that belong to the OS and to other layers, and
        // this branch used to swallow them. Matches the guard on the capture listener above.
        //
        // That capture-phase listener normally consumes a bare Escape before this runs; this branch
        // is the fallback for the frame between the mic click and `starting` landing in state.
        // Any live turn, including one still delivering (terminals keep their Escape for that phase).
        if (turnLive) {
          e.preventDefault();
          cancelRecording();
        } else if (live.active) {
          e.preventDefault();
          live.stop();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelRecording, live, turnLive]);

  return {
    adapter,
    stt,
    phase: voicePhase,
    held,
    heldPrompt: heldPrompt.held,
    captureRoute,
    // Read through the text, like the ref: an emptied bar keeps nothing.
    keptFor: text.trim() ? keptFor : null,
    beginVoice,
    cancelRecording,
    submitTyped,
    turnLive,
    voiceOpen: capturingNow,
    sendHeldPrompt: heldPrompt.send,
    clearHeldPrompt: heldPrompt.clear,
    onMic,
    toggleLive,
  };
}
