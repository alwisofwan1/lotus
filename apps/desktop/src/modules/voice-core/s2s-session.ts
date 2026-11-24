/**
 * Voice-to-Voice (speech-to-speech) conversational session — pure decision core.
 *
 * This is the brain of the duplex voice loop that Fase 3 of the voice-to-voice feature builds on
 * (see `plans/voice-to-voice/research-and-analysis.md`). It is a pure reducer, mirroring
 * `canvas-live-loop`: given the current {@link S2sSession} and an inbound {@link S2sEvent}, it
 * returns the next session plus a list of {@link S2sEffect}s the imperative shell must carry out
 * (open the WebSocket transport, start/stop mic capture, interrupt playback, tear down).
 *
 * ADDITIVE: this module is brand new and does not touch the existing turn-based voice path
 * (`use-speech-to-text` / `use-voice-feedback` / `cloud-tts-provider`). Voice-to-voice is an
 * opt-in mode that runs alongside the current flow, never replacing it.
 */

/** Where the conversation currently is. `listening` = live, mic open, waiting for the user. */
export type S2sPhase =
  | "idle"
  | "connecting"
  | "listening"
  | "user"
  | "thinking"
  | "agent"
  /** The socket dropped mid-conversation; one silent reconnect is in flight. The mic is closed. */
  | "reconnecting"
  | "closed"
  | "error";

export interface S2sSession {
  phase: S2sPhase;
  /** Monotonic count of user utterances this session — increments each time the user starts talking. */
  turn: number;
  /** Populated only when `phase === "error"`. */
  error?: string;
}

export type S2sEvent =
  | { type: "open" }
  | { type: "ready" }
  | { type: "userSpeechStart" }
  | { type: "userSpeechEnd" }
  | { type: "agentAudioStart" }
  | { type: "agentAudioEnd" }
  | { type: "bargeIn" }
  | { type: "error"; message: string }
  /** The socket closed without the user ending the session (network blip, provider drop). */
  | { type: "drop"; message: string }
  | { type: "close" };

export type S2sEffect =
  | { type: "connect" }
  | { type: "startCapture" }
  | { type: "stopCapture" }
  | { type: "interruptPlayback" }
  /** Open a fresh socket with the same instructions and tools. Speech from the gap is never sent. */
  | { type: "reconnect" }
  | { type: "teardown" };

export interface S2sStep {
  session: S2sSession;
  effects: S2sEffect[];
}

export function initialS2sSession(): S2sSession {
  return { phase: "idle", turn: 0 };
}

export function reduceS2sSession(session: S2sSession, event: S2sEvent): S2sStep {
  // A `close` is honoured from ANY phase — including the terminal `error` — so the UI can always
  // dismiss the live surface and return to the default bar. Without this, an errored session (e.g.
  // a provider that keeps failing) is a dead-end: `close` is ignored, `phase` stays `error`, and the
  // command bar never swaps back. `error` already ran teardown, so closing from it needs no effect.
  if (event.type === "close") {
    if (session.phase === "closed") return { session, effects: [] };
    return {
      session: { ...session, phase: "closed" },
      effects: session.phase === "error" ? [] : [{ type: "teardown" }],
    };
  }
  // Other events are inert once terminal — the session is done and holds no transport to act on.
  if (session.phase === "closed" || session.phase === "error") return { session, effects: [] };
  if (session.phase === "reconnecting" && event.type !== "ready" && event.type !== "error" && event.type !== "drop") {
    // Speech events can only come from the dead socket; nothing happens until the new one is ready.
    return { session, effects: [] };
  }
  switch (event.type) {
    case "drop":
      if (session.phase === "idle") return { session, effects: [] };
      // One reconnect per drop: a drop before the first connect, or while reconnecting, is final.
      if (session.phase === "connecting" || session.phase === "reconnecting") {
        return {
          session: {
            ...session,
            phase: "error",
            error:
              session.phase === "reconnecting"
                ? `Live Voice lost its connection and could not reconnect: ${event.message}`
                : event.message,
          },
          effects: [{ type: "teardown" }],
        };
      }
      return {
        session: { ...session, phase: "reconnecting" },
        effects: [{ type: "stopCapture" }, { type: "reconnect" }],
      };
    case "error":
      return {
        session: { ...session, phase: "error", error: event.message },
        effects: [{ type: "teardown" }],
      };
    // (`close` is fully handled above — honoured from every phase, including terminal ones.)
    case "open":
      return { session: { ...session, phase: "connecting" }, effects: [{ type: "connect" }] };
    case "ready":
      return { session: { ...session, phase: "listening" }, effects: [{ type: "startCapture" }] };
    case "userSpeechStart":
      return { session: { ...session, phase: "user", turn: session.turn + 1 }, effects: [] };
    case "userSpeechEnd":
      return { session: { ...session, phase: "thinking" }, effects: [] };
    case "agentAudioStart":
      return { session: { ...session, phase: "agent" }, effects: [] };
    case "agentAudioEnd":
      return { session: { ...session, phase: "listening" }, effects: [] };
    case "bargeIn":
      // Only meaningful while the agent holds the floor — cut its audio and hand back to the user.
      if (session.phase !== "agent") return { session, effects: [] };
      return {
        session: { ...session, phase: "user", turn: session.turn + 1 },
        effects: [{ type: "interruptPlayback" }],
      };
    default:
      return { session, effects: [] };
  }
}
