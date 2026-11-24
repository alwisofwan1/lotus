export type S2sLatencyMilestone =
  | "speech-start"
  | "speech-end"
  | "transcript-final"
  | "tool-start"
  | "tool-end"
  | "first-audio-delta";

/** Sanitized timing only: never include transcript text, provider/session ids, or realtime call ids. */
export interface S2sLatencyEventInput {
  milestone: S2sLatencyMilestone;
  turn: number;
  elapsedFromSpeechEndMs?: number;
  durationMs?: number;
}

export interface S2sLatencyTracker {
  beginTurn: (turn: number, nowMs?: number) => void;
  markSpeechEnd: (turn: number, nowMs?: number) => void;
  markTranscriptFinal: (turn: number, nowMs?: number) => void;
  markToolStart: (turn: number, privateCallId: string, nowMs?: number) => void;
  markToolEnd: (privateCallId: string, nowMs?: number) => void;
  markFirstAudio: (turn: number, nowMs?: number) => void;
  reset: () => void;
}

interface TurnTiming {
  turn: number;
  speechEndAtMs?: number;
  transcriptFinalRecorded: boolean;
  firstAudioRecorded: boolean;
}

interface ToolTiming {
  turn: number;
  startedAtMs: number;
  speechEndAtMs?: number;
}

function elapsed(nowMs: number, sinceMs?: number): number | undefined {
  return typeof sinceMs === "number" ? Math.max(0, nowMs - sinceMs) : undefined;
}

function withElapsed(
  event: S2sLatencyEventInput,
  elapsedFromSpeechEndMs: number | undefined,
): S2sLatencyEventInput {
  return typeof elapsedFromSpeechEndMs === "number"
    ? { ...event, elapsedFromSpeechEndMs }
    : event;
}

/**
 * Session-local latency tracker. Realtime call ids are used only as private correlation keys and are
 * never emitted. The recorder receives compact per-turn milestones suitable for support diagnostics.
 */
export function createS2sLatencyTracker(
  record: (event: S2sLatencyEventInput) => void,
): S2sLatencyTracker {
  let current: TurnTiming | null = null;
  const tools = new Map<string, ToolTiming>();

  return {
    beginTurn(turn) {
      if (current?.turn === turn) return;
      current = {
        turn,
        transcriptFinalRecorded: false,
        firstAudioRecorded: false,
      };
      record({ milestone: "speech-start", turn });
    },

    markSpeechEnd(turn, nowMs = Date.now()) {
      if (!current || current.turn !== turn || typeof current.speechEndAtMs === "number") return;
      current.speechEndAtMs = nowMs;
      record({ milestone: "speech-end", turn });
    },

    markTranscriptFinal(turn, nowMs = Date.now()) {
      if (!current || current.turn !== turn || current.transcriptFinalRecorded) return;
      current.transcriptFinalRecorded = true;
      record(withElapsed(
        { milestone: "transcript-final", turn },
        elapsed(nowMs, current.speechEndAtMs),
      ));
    },

    markToolStart(turn, privateCallId, nowMs = Date.now()) {
      if (tools.has(privateCallId)) return;
      const speechEndAtMs = current?.turn === turn ? current.speechEndAtMs : undefined;
      tools.set(privateCallId, { turn, startedAtMs: nowMs, speechEndAtMs });
      record(withElapsed(
        { milestone: "tool-start", turn },
        elapsed(nowMs, speechEndAtMs),
      ));
    },

    markToolEnd(privateCallId, nowMs = Date.now()) {
      const timing = tools.get(privateCallId);
      if (!timing) return;
      tools.delete(privateCallId);
      const base = withElapsed(
        { milestone: "tool-end", turn: timing.turn },
        elapsed(nowMs, timing.speechEndAtMs),
      );
      record({ ...base, durationMs: Math.max(0, nowMs - timing.startedAtMs) });
    },

    markFirstAudio(turn, nowMs = Date.now()) {
      if (!current || current.turn !== turn || current.firstAudioRecorded) return;
      current.firstAudioRecorded = true;
      record(withElapsed(
        { milestone: "first-audio-delta", turn },
        elapsed(nowMs, current.speechEndAtMs),
      ));
    },

    reset() {
      current = null;
      tools.clear();
    },
  };
}
