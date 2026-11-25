"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { S2sStreamEvent } from "@/lib/tauri-api";
import { useTauriVoicePort } from "@/modules/voice-core/voice-port-context";
import {
  initialS2sSession,
  reduceS2sSession,
  type S2sEvent,
  type S2sSession,
} from "@/modules/voice-core/s2s-session";
import {
  translateS2sStreamEvent,
  type S2sToolCall,
  type S2sTranscriptionFailure,
} from "./s2s-stream-bridge";
import { pcm16Base64ByteLength, type Pcm16StreamPlayer } from "./pcm16-stream-player";
import {
  beginAssistantAudioItem,
  decideBargeInTruncate,
  initialS2sTruncatePolicyState,
  markAssistantAudioItemComplete,
  markTruncateIssued,
  recordEnqueuedAudioBytes,
  recordPlayedAudioBytes,
  PCM16_BYTES_PER_SAMPLE,
} from "./s2s-truncate-policy";
import { createS2sPlayback, type S2sPlayback } from "./s2s-playback";
import { createPcmCapture, type PcmCapture } from "@/modules/voice-core/pcm-capture";
import { s2sEndRefusal } from "./s2s-end-conversation";
import { createChimePlayer, LIVE_VOICE_END_SOUND_SRC, type ChimePlayer } from "@/modules/voice-core/agent-done-chime";
import { isS2sSpeechLikeMicChunk, shouldTriggerS2sLocalBargeIn } from "./s2s-local-barge-in";
import {
  recordS2sVoiceHealthDiagnostic,
  recordS2sVoiceLatencyDiagnostic,
} from "./s2s-voice-diagnostics";
import { createS2sLatencyTracker } from "./s2s-latency-tracker";
import {
  createS2sToolCallRuntime,
  type S2sToolCallRuntime,
} from "./s2s-tool-call-runtime";
import {
  toRealtimeTools,
  type ConciergeAction,
  type RealtimeTool,
} from "./s2s-concierge-bridge";
import type { S2sAutoEndPolicy, S2sAutoEndReason } from "./s2s-auto-end-policy";
import {
  createS2sAutoEndRuntime,
  type S2sAutoEndRuntime,
} from "./s2s-auto-end-runtime";

/**
 * Voice-to-Voice duplex session hook — the thin imperative shell that binds the tested cores:
 * `reduceS2sSession` (state), `translateS2sStreamEvent` (transport→state mapping), the streaming
 * PCM16 player (playback), the Rust `s2s_stream_*` transport, and Web Audio mic capture. All
 * decisions live in those pure modules; this hook only carries out the effects.
 *
 * ADDITIVE: nothing here runs unless the caller (gated by `resolveS2sEngagement`) starts a session.
 * The turn-based STT/TTS hooks are untouched.
 */

/** OpenAI-Realtime-compatible providers use 24 kHz PCM16 for BOTH input and output — the mic capture
 *  must resample to this, not the 16 kHz the Deepgram STT path uses, or the model hears the wrong
 *  pitch/speed and its VAD never fires. */
const S2S_SAMPLE_RATE = 24000;
const NO_RESPONSE_ID_BARGE_IN_QUARANTINE_MS = 650;
const NO_RESPONSE_ID_AFTER_USER_END_QUARANTINE_MS = 450;
const LOCAL_BARGE_IN_DROP_MS = 1_100;
const RECENT_AGENT_AUDIO_MS = 1_200;
const NATIVE_DIAGNOSTICS_POLL_MS = 1_000;
/** Quiet time before a changed Live Voice context (instructions/tools) is sent to the provider. */
const CONTEXT_UPDATE_DEBOUNCE_MS = 400;
/** Wait before the one silent reconnect, so a short network blip can pass before the new socket opens. */
const RECONNECT_DELAY_MS = 1_000;
/** A drop this soon after a reconnect counts as the second failure — no endless silent loop. */
const RECONNECT_STABLE_MS = 15_000;

/** Opt-in playback tracing: set `localStorage.LOTUS_S2S_DEBUG = "1"` in the webview devtools console.
 *  Logs the playback AudioContext state + each delta size so a "no sound" report can be pinned to the
 *  context (suspended/locked) vs. the data (empty deltas) without guessing. */
function s2sPlaybackDebug(): boolean {
  try {
    return typeof localStorage !== "undefined" && !!localStorage.getItem("LOTUS_S2S_DEBUG");
  } catch {
    return false;
  }
}

function realtimeToolConfig(opts: UseS2sSessionOpts): { toolsJson?: string; key: string } {
  const conciergeOn = !!opts.onConciergeAction;
  const toolsJson = conciergeOn ? JSON.stringify(opts.realtimeTools ?? toRealtimeTools()) : undefined;
  return { toolsJson, key: JSON.stringify({ instructions: opts.instructions ?? "", toolsJson: toolsJson ?? "" }) };
}

export type S2sSocketHealth = "idle" | "connecting" | "connected" | "closed" | "error";
export type S2sMicHealth = "idle" | "starting" | "active" | "error";
export type S2sPlaybackHealth = "idle" | "ready" | "playing" | "error";
export type S2sToolHealth = "idle" | "running" | "ok" | "error";

export interface S2sHealthSnapshot {
  socket: S2sSocketHealth;
  mic: S2sMicHealth;
  playback: S2sPlaybackHealth;
  tools: S2sToolHealth;
  audioDeltas: number;
  nativeQueueUsed?: number;
  nativeDroppedAudioChunks?: number;
  lastIssue?: string;
  lastTool?: string;
}

const INITIAL_HEALTH: S2sHealthSnapshot = {
  socket: "idle",
  mic: "idle",
  playback: "idle",
  tools: "idle",
  audioDeltas: 0,
};

/** How long `end_conversation` waits for the user's final transcript of the same turn. */
const END_TRANSCRIPT_WAIT_MS = 1_500;

export interface S2sSessionHandle {
  session: S2sSession;
  /** True while the model is actively speaking (audio scheduled ahead of the clock). */
  agentSpeaking: boolean;
  /** Sanitized live health for UI/status/diagnostics — no audio, transcript, ids, or secrets. */
  health: S2sHealthSnapshot;
  start: () => Promise<void>;
  stop: () => void;
  /** Manual barge-in (e.g. a push-to-talk key) in addition to server-VAD detection. */
  interrupt: () => void;
  /** The user's own mic is muted: the agent keeps talking, nothing the room says reaches it. */
  micMuted: boolean;
  setMicMuted: (muted: boolean) => void;
  /** The model accepted a sign-off and is saying goodbye; the session closes when it finishes. */
  ending: boolean;
}

/** Who a transcript fragment is from and where it belongs. `turn` is the session turn it arrived in. */
export interface S2sTranscriptMeta {
  speaker?: "user" | "agent";
  itemId?: string;
  /** The text replaces what was heard for the item so far (xAI `…updated`). */
  cumulative?: boolean;
  turn: number;
}

export interface UseS2sSessionOpts {
  providerId: string;
  /** System instructions for the realtime voice persona. */
  instructions?: string;
  /** Display-only transcript fragments (both sides). */
  onTranscript?: (text: string, isFinal: boolean, meta: S2sTranscriptMeta) => void;
  /** Server-VAD boundary for a new user turn; lets authoritative consumers invalidate prior input. */
  onUserSpeechStart?: () => void;
  /** Partial and final user STT progress, used only to adapt the short transcript/tool race wait.
   *  `itemId` identifies the realtime item, letting a cumulative provider's refined text REPLACE the
   *  item's earlier text instead of being appended to it. */
  onUserTranscriptProgress?: (
    text: string,
    isFinal: boolean,
    meta?: { itemId?: string; cumulative?: boolean },
  ) => void;
  /** Final user speech only; authoritative input for delegation compilation. */
  onFinalUserTranscript?: (text: string, itemId?: string) => void;
  /** One input transcription attempt failed. Recoverable and per-item — the session keeps running. */
  onTranscriptionFailed?: (failure: S2sTranscriptionFailure) => void;
  /** The model finished a full spoken reply — an uninterrupted agent turn. Barge-ins cancel the reply
   *  before its final transcript, so this intentionally does NOT fire for them. */
  onAgentFinalTranscript?: () => void;
  /** Caller-provided realtime tools. If omitted, the legacy concierge MCP tools are advertised. */
  realtimeTools?: RealtimeTool[];
  /** When set, the concierge tools are advertised and each tool call is resolved to a local/MCP action
   *  and handed to this callback (the shell performs the actual canvas/MCP operation). */
  onConciergeAction?: (action: ConciergeAction, call: S2sToolCall) => unknown | Promise<unknown>;
  /** True while the app is waiting for a short user clarification, giving auto-idle a longer grace. */
  hasPendingClarification?: boolean;
  /** Called after client-side auto-end closes the live session through the normal teardown path. */
  onAutoEnd?: (reason: S2sAutoEndReason, message: string) => void;
  /** Auto-end thresholds. Defaults to {@link S2S_AUTO_END_DEFAULTS}; the canvas passes a policy derived
   *  from the "auto-close after each command" preference so users can keep the session open across turns. */
  autoEndPolicy?: S2sAutoEndPolicy;
  /** Wait before the silent reconnect after a drop. Defaults to {@link RECONNECT_DELAY_MS}. */
  reconnectDelayMs?: number;
}

export function useS2sSession(opts: UseS2sSessionOpts): S2sSessionHandle {
  const [session, setSession] = useState<S2sSession>(initialS2sSession);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [health, setHealth] = useState<S2sHealthSnapshot>(INITIAL_HEALTH);
  // Tauri Voice Port (ADR-0053). Read through a ref so the stable callbacks below keep their deps.
  const port = useTauriVoicePort();
  const portRef = useRef(port);
  portRef.current = port;
  const healthRef = useRef<S2sHealthSnapshot>(INITIAL_HEALTH);
  const lastUserFinalRef = useRef<{ turn: number; text: string } | null>(null);
  const [micMuted, setMicMutedState] = useState(false);
  const [ending, setEnding] = useState(false);
  const endChimeRef = useRef<ChimePlayer | null>(null);
  const micMutedRef = useRef(false);
  const setMicMuted = useCallback((muted: boolean) => {
    micMutedRef.current = muted;
    setMicMutedState(muted);
  }, []);

  const sessionIdRef = useRef<string | null>(null);
  const sessionRef = useRef<S2sSession>(session);
  const playerRef = useRef<Pcm16StreamPlayer | null>(null);
  const playbackRef = useRef<S2sPlayback | null>(null);
  const captureRef = useRef<PcmCapture | null>(null);
  // Monotonic capture generation: bumped whenever capture is stopped/torn down, so an in-flight
  // async `startCapture` can tell its mic is already unwanted and NOT orphan it (P0-2).
  const captureGenRef = useRef(0);
  // Synchronous "a start is in flight" latch. `sessionIdRef` is only set AFTER the awaited
  // `s2sStreamStart`, so it can't guard against a second `start()` (double click / StrictMode)
  // landing during that await — which would open a second AudioContext + Rust session (P0-3).
  const startingRef = useRef(false);
  // Monotonic connection generation: bumped on every start and teardown so a socket that resolves
  // after the user already ended the connecting session is closed immediately, not retained as a
  // hidden/zombie `sessionIdRef` that blocks future starts.
  const startGenRef = useRef(0);
  // After a barge-in, providers can still flush audio deltas from the cancelled response. Prefer the
  // provider response id when present so late old-response deltas are dropped even after userSpeechEnd;
  // keep the timing gate for providers that omit response_id.
  const dropReplyAudioUntilUserEndRef = useRef(false);
  const noResponseIdDropUntilMsRef = useRef(0);
  const localBargeInDropUntilMsRef = useRef(0);
  const recentAgentAudioUntilMsRef = useRef(0);
  const lastLocalBargeInAtMsRef = useRef(0);
  const lastReplyResponseIdRef = useRef<string | null>(null);
  const cancelledResponseIdsRef = useRef<Set<string>>(new Set());
  const latencyTrackerRef = useRef(createS2sLatencyTracker(recordS2sVoiceLatencyDiagnostic));
  const toolCallRuntimeRef = useRef<S2sToolCallRuntime | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const sessionConfigRef = useRef<string | null>(null);
  const nativeDiagnosticsTimerRef = useRef<number | null>(null);
  const lastNativeDroppedRef = useRef(0);
  const applyRef = useRef<(event: S2sEvent) => void>(() => {});
  const reconnectRef = useRef<() => Promise<void>>(async () => {});
  const lastReconnectAtRef = useRef<number | null>(null);
  const autoEndRuntimeRef = useRef<S2sAutoEndRuntime | null>(null);

  const updateHealth = useCallback((patch: Partial<S2sHealthSnapshot>, record = false) => {
    const next = { ...healthRef.current, ...patch };
    healthRef.current = next;
    setHealth(next);
    if (record) {
      recordS2sVoiceHealthDiagnostic({
        socket: next.socket,
        mic: next.mic,
        playback: next.playback,
        tools: next.tools,
        audioDeltas: next.audioDeltas,
        ...(next.lastIssue ? { issue: next.lastIssue } : {}),
        ...(next.lastTool ? { lastTool: next.lastTool } : {}),
      });
    }
  }, []);

  if (!autoEndRuntimeRef.current) {
    autoEndRuntimeRef.current = createS2sAutoEndRuntime({
      getPhase: () => sessionRef.current.phase,
      getAgentSpeaking: () => !!playerRef.current?.active || sessionRef.current.phase === "agent",
      hasPendingClarification: () => !!optsRef.current.hasPendingClarification,
      getPolicy: () => optsRef.current.autoEndPolicy,
      onEnd: (reason, message) => {
        // A soft cue that Live Voice closed by itself; the End button needs none.
        endChimeRef.current ??= createChimePlayer({ batchMs: 0, playNative: async (id) => portRef.current.playAgentDoneSound(id) });
        endChimeRef.current.play(LIVE_VOICE_END_SOUND_SRC);
        optsRef.current.onAutoEnd?.(reason, message);
        applyRef.current({ type: "close" });
      },
    });
  }

  const markActivity = useCallback(() => {
    autoEndRuntimeRef.current?.markActivity();
  }, []);

  if (!toolCallRuntimeRef.current) {
    toolCallRuntimeRef.current = createS2sToolCallRuntime({
      getSessionId: () => sessionIdRef.current,
      getPhase: () => sessionRef.current.phase,
      getTurn: () => sessionRef.current.turn,
      getHandler: () => optsRef.current.onConciergeAction,
      updateHealth,
      markTurnSettled: () => autoEndRuntimeRef.current?.markTurnSettled(),
      requestGracefulEnd: (reason, farewell) => {
        autoEndRuntimeRef.current?.requestGracefulEnd(reason, farewell);
        if (autoEndRuntimeRef.current?.hasPendingGracefulEnd()) setEnding(true);
      },
      checkEnd: async () => {
        // The tool call can beat the user's final transcript; give this turn's words a moment to land.
        const turn = sessionRef.current.turn;
        for (let waited = 0; lastUserFinalRef.current?.turn !== turn && waited < END_TRANSCRIPT_WAIT_MS; waited += 100) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const last = lastUserFinalRef.current;
        return s2sEndRefusal(last?.turn === turn ? last.text : null, healthRef.current.tools === "running");
      },
      latencyTracker: latencyTrackerRef.current,
      sendToolResult: (sessionId, callId, output, continueResponse) =>
        portRef.current.s2s.toolResult(sessionId, callId, output, continueResponse),
    });
  }

  /** Apply a reducer event and carry out the effects it produces. */
  // Barge-in truncation accounting. `response.cancel` alone leaves the provider believing it said the
  // whole reply; `conversation.item.truncate` tells it how much the user actually HEARD. Audio deltas
  // can arrive before the item id does, so bytes are held in `pendingAssistantBytesRef` until an
  // assistant transcript names the item, then folded in.
  const truncateStateRef = useRef(initialS2sTruncatePolicyState());
  const assistantItemIdRef = useRef<string | null>(null);
  const pendingAssistantBytesRef = useRef(0);
  const playedSamplesBaselineRef = useRef(0);

  /**
   * Stop playback and, if the user heard only part of the assistant item, truncate it server-side.
   * Every barge-in path routes through here so none can silently skip the truncate — `player.interrupt()`
   * is called first because it banks the partially-heard segment into `playedSamples`.
   */
  const interruptPlaybackAndTruncate = useCallback(() => {
    const player = playerRef.current;
    player?.interrupt();
    const itemId = assistantItemIdRef.current;
    if (!itemId) return; // provider never named the item — no valid truncate is possible
    // `recordPlayedAudioBytes` ACCUMULATES, and this helper reports the item's whole played total, so
    // re-reporting after a truncate was already issued would double-count. `decideBargeInTruncate` is
    // itself idempotent, but keeping the accounting exact means the state stays inspectable.
    if (truncateStateRef.current.truncatedItemId === itemId) return;
    const playedSamples = Math.max(0, (player?.playedSamples ?? 0) - playedSamplesBaselineRef.current);
    truncateStateRef.current = recordPlayedAudioBytes(
      truncateStateRef.current,
      itemId,
      playedSamples * PCM16_BYTES_PER_SAMPLE,
    );
    const decision = decideBargeInTruncate(truncateStateRef.current);
    if (!decision.shouldTruncate) return;
    truncateStateRef.current = markTruncateIssued(truncateStateRef.current, decision.itemId);
    const sid = sessionIdRef.current;
    if (sid) void portRef.current.s2s.truncate(sid, decision.itemId, decision.audioEndMs);
  }, []);

  const apply = useCallback((event: S2sEvent) => {
    const { session: next, effects } = reduceS2sSession(sessionRef.current, event);
    sessionRef.current = next;
    setSession(next);
    const sid = sessionIdRef.current;
    for (const effect of effects) {
      switch (effect.type) {
        case "startCapture":
          void startCapture();
          break;
        case "stopCapture":
          stopCapture();
          break;
        case "interruptPlayback":
          dropReplyAudioUntilUserEndRef.current = true;
          noResponseIdDropUntilMsRef.current = Date.now() + NO_RESPONSE_ID_BARGE_IN_QUARANTINE_MS;
          if (lastReplyResponseIdRef.current) {
            cancelledResponseIdsRef.current.add(lastReplyResponseIdRef.current);
          }
          playbackRef.current?.setMuted(true);
          if (sid) void portRef.current.s2s.interrupt(sid);
          // Truncate AFTER cancel, per the realtime docs' ordering for an interrupted response.
          interruptPlaybackAndTruncate();
          setAgentSpeaking(false);
          break;
        case "teardown":
          teardown();
          break;
        case "reconnect":
          void reconnectRef.current();
          break;
        case "connect":
          // handled by start() opening the socket
          break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  applyRef.current = apply;

  const startCapture = useCallback(async () => {
    if (captureRef.current || typeof navigator === "undefined") return;
    const gen = ++captureGenRef.current; // claim this attempt
    // Mic capture + downsample (24 kHz) + PCM16 + base64 run on the AudioWorklet render thread; the
    // main thread only forwards each chunk to the realtime socket. No spectrum tap in duplex mode.
    let capture: PcmCapture;
    try {
      capture = await createPcmCapture({
        targetRate: S2S_SAMPLE_RATE,
        // Duplex needs the echo canceller: the agent speaks through the same speakers this mic hears,
        // and without it the reply re-triggers server VAD and cancels itself mid-sentence. This is the
        // only path that opts in — see `PcmCaptureOptions.voiceProcessing` for what it costs.
        voiceProcessing: true,
        onChunk: (b64) => {
          if (micMutedRef.current) {
            // Send silence of the same length, not nothing: server VAD still sees a turn end, and
            // muted speech cannot barge in.
            const sid = sessionIdRef.current;
            if (sid) void portRef.current.s2s.send(sid, muteChunk(b64)).catch(() => {});
            return;
          }
          const now = Date.now();
          if (isS2sSpeechLikeMicChunk(b64)) {
            // Mic audio is the earliest evidence that the user is taking a turn. Server VAD can lag
            // behind the first speechy chunks, so local speech must pause completed-turn auto-close
            // before the provider emits `input_audio_buffer.speech_started`.
            autoEndRuntimeRef.current?.markActivity(now);
            autoEndRuntimeRef.current?.markTurnActive();
          }
          if (
            shouldTriggerS2sLocalBargeIn({
              audioBase64: b64,
              agentAudioRecent: now < recentAgentAudioUntilMsRef.current || !!playerRef.current?.active,
              nowMs: now,
              lastTriggerMs: lastLocalBargeInAtMsRef.current,
            })
          ) {
            lastLocalBargeInAtMsRef.current = now;
            localBargeInDropUntilMsRef.current = now + LOCAL_BARGE_IN_DROP_MS;
            noResponseIdDropUntilMsRef.current = Math.max(
              noResponseIdDropUntilMsRef.current,
              now + NO_RESPONSE_ID_BARGE_IN_QUARANTINE_MS,
            );
            if (lastReplyResponseIdRef.current) {
              cancelledResponseIdsRef.current.add(lastReplyResponseIdRef.current);
            }
            playbackRef.current?.setMuted(true);
            interruptPlaybackAndTruncate();
            setAgentSpeaking(false);
          }
          const sid = sessionIdRef.current;
          if (sid) void portRef.current.s2s.send(sid, b64).catch(() => {});
        },
      });
    } catch (err) {
      // If teardown already invalidated this capture attempt, the failure belongs to a closed session
      // and must not resurrect UI state. Otherwise surface it and tear down the already-open socket.
      if (captureGenRef.current === gen) {
        const message = err instanceof Error ? err.message : String(err);
        updateHealth({ mic: "error", lastIssue: message }, true);
        applyRef.current({ type: "error", message });
      }
      return;
    }
    // A stop/teardown (or a competing startCapture) ran during the await → this mic is already
    // unwanted. Release it now instead of assigning a capture nobody will ever stop (P0-2).
    if (captureGenRef.current !== gen) {
      capture.stop();
      return;
    }
    captureRef.current = capture;
    updateHealth({ mic: "active" }, true);
  }, [interruptPlaybackAndTruncate, updateHealth]);

  const stopCapture = useCallback(() => {
    captureGenRef.current++; // invalidate any in-flight startCapture
    captureRef.current?.stop();
    captureRef.current = null;
  }, []);

  const stopNativeDiagnostics = useCallback(() => {
    if (nativeDiagnosticsTimerRef.current !== null) {
      window.clearInterval(nativeDiagnosticsTimerRef.current);
      nativeDiagnosticsTimerRef.current = null;
    }
  }, []);

  const startNativeDiagnostics = useCallback(
    (sid: string) => {
      stopNativeDiagnostics();
      if (typeof window === "undefined") return;
      nativeDiagnosticsTimerRef.current = window.setInterval(() => {
        void portRef.current.s2s.diagnostics(sid)
          .then((diag) => {
            if (!diag) return;
            const dropped = diag.droppedAudioChunks;
            const droppedIncreased = dropped > lastNativeDroppedRef.current;
            lastNativeDroppedRef.current = dropped;
            updateHealth(
              {
                nativeQueueUsed: diag.queueUsed,
                nativeDroppedAudioChunks: dropped,
                ...(droppedIncreased ? { lastIssue: `Dropped ${dropped} mic audio chunks under load.` } : {}),
              },
              droppedIncreased,
            );
          })
          .catch(() => {});
      }, NATIVE_DIAGNOSTICS_POLL_MS);
    },
    [stopNativeDiagnostics, updateHealth],
  );

  /** Forget everything tied to the dropped socket: its id, its half-played reply, its tool calls. */
  const resetSocketState = useCallback(() => {
    stopNativeDiagnostics();
    lastNativeDroppedRef.current = 0;
    sessionIdRef.current = null;
    dropReplyAudioUntilUserEndRef.current = false;
    noResponseIdDropUntilMsRef.current = 0;
    localBargeInDropUntilMsRef.current = 0;
    recentAgentAudioUntilMsRef.current = 0;
    lastLocalBargeInAtMsRef.current = 0;
    lastReplyResponseIdRef.current = null;
    cancelledResponseIdsRef.current.clear();
    truncateStateRef.current = initialS2sTruncatePolicyState();
    assistantItemIdRef.current = null;
    pendingAssistantBytesRef.current = 0;
    playedSamplesBaselineRef.current = 0;
    latencyTrackerRef.current.reset();
    toolCallRuntimeRef.current?.reset();
  }, [stopNativeDiagnostics]);

  const teardown = useCallback(() => {
    startGenRef.current++; // invalidate any in-flight realtime connect
    autoEndRuntimeRef.current?.stopSession();
    const preserveErrorHealth = sessionRef.current.phase === "error";
    const sid = sessionIdRef.current;
    if (sid) void portRef.current.s2s.close(sid);
    // A new session gets a fresh player, so the played-sample baseline from the old one is meaningless.
    resetSocketState();
    stopCapture();
    playbackRef.current?.setMuted(false);
    setMicMuted(false); // every new session starts with the mic open
    setEnding(false);
    lastUserFinalRef.current = null;
    playbackRef.current?.dispose();
    playbackRef.current = null;
    playerRef.current = null;
    setAgentSpeaking(false);
    updateHealth(preserveErrorHealth ? { socket: "error" } : { socket: "closed", mic: "idle", playback: "idle", tools: "idle" }, true);
  }, [resetSocketState, setMicMuted, stopCapture, updateHealth]);

  // Unmount cleanup (P0-1): if the command bar unmounts mid-session (navigation, StrictMode), tear
  // the whole session down — otherwise the WebSocket, mic AudioContext, capture worklet and any
  // in-flight reply audio leak and the mic indicator stays lit. A ref keeps this a run-once effect
  // that always calls the LATEST teardown.
  const teardownRef = useRef(teardown);
  teardownRef.current = teardown;
  useEffect(() => () => teardownRef.current(), []);

  /** One event from the CURRENT realtime socket. {@link openSocket} drops events from older sockets. */
  const handleStreamEvent = (ev: S2sStreamEvent) => {
    if (ev.kind !== "closed") markActivity();
    // Barge-in (per OpenAI/Grok WebSocket guidance): the model streams reply audio FASTER than
    // realtime, so `response.done` (→ phase "listening") usually fires while the client is still
    // draining buffered audio. Gating the cut on phase==="agent" misses exactly that window. So
    // whenever the user starts speaking AND the agent is still audible, stop playback NOW. The
    // server (interrupt_response:true) cancels generation; the client owns stopping playback.
    if (ev.kind === "userSpeechStart") {
      optsRef.current.onUserSpeechStart?.();
      updateHealth({ tools: "idle", lastTool: undefined });
      autoEndRuntimeRef.current?.markTurnActive();
      // Talking over the goodbye means the user is not done yet.
      autoEndRuntimeRef.current?.cancelGracefulEnd();
      setEnding(false);
      dropReplyAudioUntilUserEndRef.current = true;
      noResponseIdDropUntilMsRef.current = Date.now() + NO_RESPONSE_ID_BARGE_IN_QUARANTINE_MS;
      if (lastReplyResponseIdRef.current) {
        cancelledResponseIdsRef.current.add(lastReplyResponseIdRef.current);
      }
      // Flush the local media sink even when the scheduler cursor says inactive: WebKit/HTMLMedia
      // can still have a short audible tail, and that tail re-enters the mic as stutter/echo.
      playbackRef.current?.setMuted(true);
      interruptPlaybackAndTruncate();
      setAgentSpeaking(false);
      // This event comes from server VAD. The realtime session already has
      // interrupt_response=true, so the server owns cancelling the response. Sending an explicit
      // response.cancel here can race that automatic cancellation and close some providers.
      apply({ type: "userSpeechStart" });
      latencyTrackerRef.current.beginTurn(sessionRef.current.turn);
      return;
    }
    if (ev.kind === "userSpeechEnd") {
      latencyTrackerRef.current.markSpeechEnd(sessionRef.current.turn);
      dropReplyAudioUntilUserEndRef.current = false;
      playbackRef.current?.setMuted(false);
      noResponseIdDropUntilMsRef.current = Math.max(
        noResponseIdDropUntilMsRef.current,
        Date.now() + NO_RESPONSE_ID_AFTER_USER_END_QUARANTINE_MS,
      );
    }
    if (ev.kind === "responseDone") {
      toolCallRuntimeRef.current?.markResponseDone();
    }
    if (ev.kind === "audioDelta") {
      autoEndRuntimeRef.current?.markTurnActive();
      // Never play model audio while server VAD says the user has the floor. Any delta in this
      // window is a race/tail and causes the audible "stuck tape" talk-over artifact.
      if (sessionRef.current.phase === "user" || Date.now() < localBargeInDropUntilMsRef.current) {
        return;
      }
      if (ev.responseId && cancelledResponseIdsRef.current.has(ev.responseId)) {
        return;
      }
      if (
        !ev.responseId &&
        (dropReplyAudioUntilUserEndRef.current || Date.now() < noResponseIdDropUntilMsRef.current)
      ) {
        return;
      }
      if (ev.responseId) {
        lastReplyResponseIdRef.current = ev.responseId;
      }
      recentAgentAudioUntilMsRef.current = Date.now() + RECENT_AGENT_AUDIO_MS;
      latencyTrackerRef.current.markFirstAudio(sessionRef.current.turn);
      updateHealth({ playback: "playing", audioDeltas: healthRef.current.audioDeltas + 1 });
      // Total the item's enqueued audio — it bounds `audio_end_ms` on barge-in. Deltas that
      // arrive before the item is named are held and folded in once it is.
      {
        const bytes = pcm16Base64ByteLength(ev.audioBase64);
        const itemId = assistantItemIdRef.current;
        if (itemId) {
          truncateStateRef.current = recordEnqueuedAudioBytes(truncateStateRef.current, itemId, bytes);
        } else {
          pendingAssistantBytesRef.current += bytes;
        }
      }
    }
    const t = translateS2sStreamEvent(ev, sessionRef.current.phase);
    if (t.playAudio) {
      playbackRef.current?.setMuted(false);
      if (s2sPlaybackDebug()) {
        console.info("[s2s] playAudio", { bytes: t.playAudio.length, active: playerRef.current?.active });
      }
      playerRef.current?.enqueue(t.playAudio);
      setAgentSpeaking(true);
    }
    if (t.transcript) {
      optsRef.current.onTranscript?.(t.transcript.text, t.transcript.isFinal, {
        speaker: t.transcript.speaker,
        itemId: t.transcript.itemId,
        cumulative: t.transcript.cumulative,
        turn: sessionRef.current.turn,
      });
      if (t.transcript.speaker === "user") {
        optsRef.current.onUserTranscriptProgress?.(t.transcript.text, t.transcript.isFinal, {
          itemId: t.transcript.itemId,
          cumulative: t.transcript.cumulative,
        });
      }
      if (t.transcript.speaker === "user" && t.transcript.isFinal) {
        latencyTrackerRef.current.markTranscriptFinal(sessionRef.current.turn);
        optsRef.current.onFinalUserTranscript?.(t.transcript.text, t.transcript.itemId);
        lastUserFinalRef.current = { turn: sessionRef.current.turn, text: t.transcript.text };
      }
      // The assistant transcript is the only frame that names the item its audio belongs to —
      // `response.output_audio.delta` carries a response id but never an item id.
      if (t.transcript.speaker === "agent" && t.transcript.itemId) {
        const itemId = t.transcript.itemId;
        if (assistantItemIdRef.current !== itemId) {
          assistantItemIdRef.current = itemId;
          playedSamplesBaselineRef.current = playerRef.current?.playedSamples ?? 0;
          truncateStateRef.current = beginAssistantAudioItem(truncateStateRef.current, itemId);
          if (pendingAssistantBytesRef.current > 0) {
            truncateStateRef.current = recordEnqueuedAudioBytes(
              truncateStateRef.current,
              itemId,
              pendingAssistantBytesRef.current,
            );
            pendingAssistantBytesRef.current = 0;
          }
        }
      }
      if (t.transcript.speaker === "agent" && t.transcript.isFinal) {
        optsRef.current.onAgentFinalTranscript?.();
      }
    }
    if (t.transcriptionFailure) {
      // Recoverable and per-item: surface it, never tear the session down over one bad segment.
      optsRef.current.onTranscriptionFailed?.(t.transcriptionFailure);
      updateHealth({ lastIssue: `transcription failed: ${t.transcriptionFailure.message}` });
    }
    if (t.toolCall) toolCallRuntimeRef.current?.handle(t.toolCall);
    if (t.event) apply(t.event);
    if (ev.kind === "agentAudioEnd") {
      autoEndRuntimeRef.current?.markAgentAudioEnd();
      playerRef.current?.end?.(); // flush the reply's trailing audio segment immediately
      // Only "complete" once the LOCAL queue has actually drained. agentAudioEnd means the
      // provider stopped SENDING, not that the user heard it — the client is usually still
      // playing buffered audio, and a barge-in in that window still has a tail to truncate.
      if (!playerRef.current?.active) {
        truncateStateRef.current = markAssistantAudioItemComplete(
          truncateStateRef.current,
          assistantItemIdRef.current,
        );
        assistantItemIdRef.current = null;
        pendingAssistantBytesRef.current = 0;
      }
      setAgentSpeaking(false);
      // A `end_conversation` farewell just finished playing — close now instead of dangling.
      if (autoEndRuntimeRef.current?.hasPendingGracefulEnd()) {
        autoEndRuntimeRef.current.finalizeGracefulEnd();
      }
    }
  };
  const handleStreamEventRef = useRef(handleStreamEvent);
  handleStreamEventRef.current = handleStreamEvent;

  /** Open a realtime socket for connection generation `gen`. Its events are ignored once a newer
   *  connection (reconnect) or a teardown bumped the generation, so a dead socket can never act. */
  const openSocket = useCallback((gen: number) => {
    const { toolsJson, key: configKey } = realtimeToolConfig(optsRef.current);
    sessionConfigRef.current = configKey;
    return portRef.current.s2s.start(
      optsRef.current.providerId,
      (ev) => {
        if (startGenRef.current !== gen) return;
        handleStreamEventRef.current(ev);
      },
      optsRef.current.instructions,
      toolsJson,
    );
  }, []);

  /** Send the current instructions and tools when they differ BY VALUE from what the socket has. */
  const refreshContext = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const currentOpts = optsRef.current;
    const { toolsJson, key } = realtimeToolConfig(currentOpts);
    if (sessionConfigRef.current === key) return;
    sessionConfigRef.current = key;
    void portRef.current.s2s.update(sid, currentOpts.instructions, toolsJson).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[s2s] failed to refresh realtime session context:", message);
      // A failed refresh leaves the session running with a STALE tool/instructions list — the model
      // may still confidently attempt a tool it no longer has, or lack one it should now have. That
      // must be visible the same way any other tool failure is, not just a console line no one reads.
      updateHealth({ tools: "error", lastIssue: message }, true);
    });
  }, [updateHealth]);

  // One silent reconnect after an unexpected drop (the reducer allows one per drop). The mic is
  // already closed; nothing captured during the gap is sent. Same instructions and tools as before.
  // A drop soon after a reconnect is the second failure. Tool calls still running and the half-played
  // reply are dropped; the new socket starts with an empty conversation.
  const reconnect = useCallback(async () => {
    const gen = ++startGenRef.current; // the dropped socket's late events are ignored from here on
    const dropped = sessionIdRef.current;
    resetSocketState();
    if (dropped) void portRef.current.s2s.close(dropped);
    playerRef.current?.interrupt();
    playbackRef.current?.setMuted(false);
    setAgentSpeaking(false);
    const lastReconnectAt = lastReconnectAtRef.current;
    if (lastReconnectAt !== null && Date.now() - lastReconnectAt < RECONNECT_STABLE_MS) {
      const message = "the connection dropped again right after reconnecting.";
      updateHealth({ socket: "error", lastIssue: message }, true);
      applyRef.current({ type: "drop", message });
      return;
    }
    updateHealth({ socket: "connecting", mic: "idle", tools: "idle", lastIssue: "Connection dropped — reconnecting." }, true);
    const delayMs = optsRef.current.reconnectDelayMs ?? RECONNECT_DELAY_MS;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (startGenRef.current !== gen || sessionRef.current.phase !== "reconnecting") return;
    }
    let sid: string;
    try {
      sid = await openSocket(gen);
    } catch (err) {
      if (startGenRef.current !== gen) return;
      const message = err instanceof Error ? err.message : String(err);
      updateHealth({ socket: "error", lastIssue: message }, true);
      applyRef.current({ type: "drop", message });
      return;
    }
    if (startGenRef.current !== gen || sessionRef.current.phase !== "reconnecting") {
      void portRef.current.s2s.close(sid);
      return;
    }
    sessionIdRef.current = sid;
    lastReconnectAtRef.current = Date.now();
    startNativeDiagnostics(sid);
    markActivity();
    updateHealth({ socket: "connected", mic: "starting", lastIssue: undefined }, true);
    applyRef.current({ type: "ready" });
    refreshContext(); // the context may have changed while there was no socket
  }, [markActivity, openSocket, refreshContext, resetSocketState, startNativeDiagnostics, updateHealth]);
  reconnectRef.current = reconnect;

  const start = useCallback(async () => {
    if (!portRef.current.isDesktop() || sessionIdRef.current || startingRef.current) return;
    startingRef.current = true; // latch BEFORE any await so a concurrent start() is rejected (P0-3)
    const startGen = ++startGenRef.current;
    try {
      // A prior session may have ended in a terminal (inert) phase — closed/error. Reset to idle first
      // so open→ready transitions are honoured again; otherwise a retry click does nothing.
      if (sessionRef.current.phase === "closed" || sessionRef.current.phase === "error") {
        sessionRef.current = initialS2sSession();
        setSession(sessionRef.current);
      }
      autoEndRuntimeRef.current?.startSession();
      lastReconnectAtRef.current = null;
      latencyTrackerRef.current.reset();
      toolCallRuntimeRef.current?.reset();

      // Streaming player backed by HTMLAudioElement, NOT AudioContext.destination: macOS WKWebView
      // silently drops AudioContext output (WebKit bug 231105 / Apple dev-forum), which is why earlier
      // resume()/unlock attempts still produced no sound even though audio deltas arrived. `new
      // Audio(blobUrl)` is the sink that works here (same as the TTS path). The player wraps buffered
      // PCM16 into gapless WAV segments — see `html-audio-pcm16-player`.
      // Seamless gapless playback: Web Audio scheduling → MediaStream → HTMLMediaElement (see
      // s2s-playback.ts). Zero segment boundaries, so no per-chunk stutter.
      const playback = createS2sPlayback(S2S_SAMPLE_RATE, (msg) => void portRef.current.debugLog(msg));
      playbackRef.current = playback;
      const player = playback.player;
      playerRef.current = player;
      updateHealth({ ...INITIAL_HEALTH, socket: "connecting", playback: "ready", lastIssue: undefined, lastTool: undefined }, true);

      apply({ type: "open" });

      const sid = await openSocket(startGen);
      if (startGenRef.current !== startGen || sessionRef.current.phase === "closed" || sessionRef.current.phase === "error") {
        void portRef.current.s2s.close(sid);
        return;
      }
      sessionIdRef.current = sid;
      startNativeDiagnostics(sid);
      autoEndRuntimeRef.current?.startPolling();
      updateHealth({ socket: "connected", mic: "starting" }, true);
      apply({ type: "ready" });
    } catch (err) {
      // Surface playback/connect failures (bad key, no realtime access, blocked audio output) as a
      // visible error state instead of a spinner that hangs forever. If the user already stopped the
      // connecting session, do not resurrect the closed UI with a stale error.
      if (startGenRef.current === startGen && sessionRef.current.phase !== "closed") {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[s2s] session failed to start:", message);
        updateHealth({ socket: "error", playback: playbackRef.current ? "ready" : "error", lastIssue: message }, true);
        apply({ type: "error", message });
      }
    } finally {
      startingRef.current = false; // release the start latch on both success and failure
    }
  }, [apply, openSocket, startNativeDiagnostics, updateHealth]);

  // Context refresh. Dragging or selecting nodes re-renders the caller many times a second; only a
  // change BY VALUE of the instructions or tool list, still there after a quiet moment, is sent.
  useEffect(() => {
    if (!sessionIdRef.current) return;
    const timer = setTimeout(refreshContext, CONTEXT_UPDATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [opts.instructions, opts.onConciergeAction, opts.realtimeTools, refreshContext]);

  const stop = useCallback(() => apply({ type: "close" }), [apply]);
  const interrupt = useCallback(() => apply({ type: "bargeIn" }), [apply]);

  return { session, agentSpeaking, health, start, stop, interrupt, micMuted, setMicMuted, ending };
}

/** Base64 PCM16 silence the same length as `b64`: all-zero bytes encode as "A", padding unchanged. */
export function muteChunk(b64: string): string {
  return b64.replace(/[^=]/g, "A");
}
