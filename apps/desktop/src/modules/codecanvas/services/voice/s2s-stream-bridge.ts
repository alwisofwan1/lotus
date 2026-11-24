/**
 * Bridge between the realtime transport events ({@link S2sStreamEvent} from `s2s_stream.rs`) and the
 * pure session state machine ({@link S2sEvent} in `s2s-session.ts`) — pure translation core.
 *
 * The duplex hook (Slice 6) is thin imperative glue: it opens the socket, pumps mic audio, and owns
 * the playback queue. Every *decision* about what a given transport event means — which reducer
 * event to fire, whether to enqueue audio, whether a user-speech signal is actually a barge-in —
 * lives here so it is unit testable without Web Audio or a live socket.
 */

import type { S2sEvent, S2sPhase } from "@/modules/voice-core/s2s-session";

/** A transport event, structurally matching `S2sStreamEvent` in `tauri-api.ts` (kept local to avoid
 *  importing the Tauri runtime module into this pure core). */
export type S2sStreamEvent =
  | { kind: "audioDelta"; audioBase64: string; responseId?: string }
  | { kind: "userSpeechStart" }
  | { kind: "userSpeechEnd" }
  | { kind: "agentAudioEnd" }
  | { kind: "responseDone" }
  | {
      kind: "transcript";
      text: string;
      isFinal: boolean;
      speaker?: "user" | "agent";
      itemId?: string;
      contentIndex?: number;
      /** True only for xAI's `…transcription.updated`: the text is the CUMULATIVE transcript of the
       *  item so far and REPLACES what was accumulated for it. An OpenAI `.delta` is incremental. */
      cumulative?: boolean;
    }
  | { kind: "toolCall"; callId: string; name: string; arguments: string }
  | { kind: "error"; message: string }
  | { kind: "transcriptionFailed"; itemId?: string; contentIndex?: number; code?: string; message: string }
  | {
      kind: "transcriptionSegment";
      id: string;
      start: number;
      end: number;
      speaker?: string;
      text: string;
    }
  | { kind: "closed" };

/** One user input-transcription attempt failed — per-item and recoverable, never terminal. */
export interface S2sTranscriptionFailure {
  itemId?: string;
  code?: string;
  message: string;
}

/** A provider-identified transcription segment (`…input_audio_transcription.segment`). */
export interface S2sTranscriptSegment {
  id: string;
  start: number;
  end: number;
  speaker?: string;
  text: string;
}

/** A concierge tool call, arguments parsed from the model's raw JSON string. */
export interface S2sToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface S2sStreamTranslation {
  /** Event to feed `reduceS2sSession`, or null when the transport event drives no state change. */
  event: S2sEvent | null;
  /** base64 PCM16 to enqueue on the playback queue, or null. */
  playAudio: string | null;
  /** A transcript fragment for display (never drives the state machine), or null. `itemId` lets the
   *  authoritative accumulator replace an item's earlier text instead of appending to it. */
  transcript: {
    text: string;
    isFinal: boolean;
    speaker?: "user" | "agent";
    itemId?: string;
    contentIndex?: number;
    /** See the transport event: only a cumulative update may be treated as authoritative while
     *  non-final. Absent/false means incremental — appending it verbatim re-creates the duplication. */
    cumulative?: boolean;
  } | null;
  /** A concierge tool call for the shell to dispatch to a Lotus MCP action, or null. */
  toolCall: S2sToolCall | null;
  /** A recoverable per-item transcription failure to surface in health/diagnostics, or null. */
  transcriptionFailure: S2sTranscriptionFailure | null;
  /** A provider-identified transcription segment, or null. */
  transcriptSegment: S2sTranscriptSegment | null;
}

/** Prefix of the error Rust sends when the socket read fails (`s2s_stream.rs`, read loop). */
const TRANSPORT_READ_ERROR_PREFIX = "realtime stream error:";

const NONE: S2sStreamTranslation = {
  event: null,
  playAudio: null,
  transcript: null,
  toolCall: null,
  transcriptionFailure: null,
  transcriptSegment: null,
};

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function translateS2sStreamEvent(
  ev: S2sStreamEvent,
  phase: S2sPhase,
): S2sStreamTranslation {
  switch (ev.kind) {
    case "audioDelta":
      // The first audio after the user's turn flips the floor to "agent"; later deltas just play.
      return {
        ...NONE,
        event: phase === "agent" ? null : { type: "agentAudioStart" },
        playAudio: ev.audioBase64,
      };
    case "userSpeechStart":
      // Speech while the agent holds the floor is a barge-in; otherwise a normal turn start.
      return { ...NONE, event: { type: phase === "agent" ? "bargeIn" : "userSpeechStart" } };
    case "userSpeechEnd":
      return { ...NONE, event: { type: "userSpeechEnd" } };
    case "agentAudioEnd":
      return { ...NONE, event: { type: "agentAudioEnd" } };
    case "responseDone":
      return NONE;
    case "transcript":
      return {
        ...NONE,
        transcript: {
          text: ev.text,
          isFinal: ev.isFinal,
          ...(ev.speaker ? { speaker: ev.speaker } : {}),
          ...(ev.itemId !== undefined ? { itemId: ev.itemId } : {}),
          ...(ev.contentIndex !== undefined ? { contentIndex: ev.contentIndex } : {}),
          ...(ev.cumulative ? { cumulative: true } : {}),
        },
      };
    case "toolCall":
      return {
        ...NONE,
        toolCall: { callId: ev.callId, name: ev.name, args: parseToolArgs(ev.arguments) },
      };
    case "error":
      // A failed socket READ (network loss) is a transport drop, not a provider error: Rust sends it
      // just before `closed` (s2s_stream.rs). Mapping it to `error` would end the session before the
      // reconnect could run.
      if (ev.message.startsWith(TRANSPORT_READ_ERROR_PREFIX)) {
        if (phase === "closed" || phase === "error") return NONE;
        return { ...NONE, event: { type: "drop", message: ev.message } };
      }
      return { ...NONE, event: { type: "error", message: ev.message } };
    case "transcriptionFailed":
      // Deliberately NOT a reducer `error`: that case tears the whole session down via a teardown
      // effect, but one item failing to transcribe is recoverable — the duplex loop must keep running.
      return {
        ...NONE,
        transcriptionFailure: {
          ...(ev.itemId !== undefined ? { itemId: ev.itemId } : {}),
          ...(ev.code !== undefined ? { code: ev.code } : {}),
          message: ev.message,
        },
      };
    case "transcriptionSegment":
      // Surfaced as data only. Whether provider segments should feed the AUTHORITATIVE accumulator is
      // an open question the Slice 0 capture answers; until then they must not silently become scope.
      return {
        ...NONE,
        transcriptSegment: {
          id: ev.id,
          start: ev.start,
          end: ev.end,
          ...(ev.speaker !== undefined ? { speaker: ev.speaker } : {}),
          text: ev.text,
        },
      };
    case "closed":
      // A transport-side close while Live Voice is active is unexpected (provider rejection, network
      // drop, or a failed session.update). It is a `drop`: the session reconnects once, silently, and
      // only a second failure is shown. User-driven End dispatches an explicit reducer `close` before
      // the socket close arrives, so terminal phases ignore this.
      if (phase === "closed" || phase === "error") return NONE;
      return { ...NONE, event: { type: "drop", message: "Realtime voice connection closed unexpectedly." } };
    default:
      return NONE;
  }
}
