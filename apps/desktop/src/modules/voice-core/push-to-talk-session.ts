/**
 * **Push-to-Talk session** (ADR-0053, plans/voice-core stories 18-23, 32-34, 53) — one pure reducer
 * that owns the life of a turn: mic opening → recording → transcribing → delivering → idle.
 *
 * - One turn at a time. A typed or spoken submit while another turn delivers is ignored — the
 *   in-flight guard lives here, not in render-time state, so two fast Enters run once.
 * - A new recording supersedes the old turn (`abort-turn`): its late transcript or delivery never
 *   applies. Escape cancels the live turn (a capture, or a delivery still running). An empty transcript is ignored.
 * - Every turn has a number; events carry it, and events for an old turn are dropped.
 *
 * Framework-free: state + event → state + effects. {@link createPushToTalkSession} runs the effects.
 */

export type PushToTalkPhase = "idle" | "starting" | "recording" | "transcribing" | "delivering";
export type PushToTalkSource = "voice" | "typed";

export interface PushToTalkState {
  phase: PushToTalkPhase;
  /** The current turn's number; 0 before the first turn. */
  turn: number;
}

export const INITIAL_PUSH_TO_TALK_STATE: PushToTalkState = { phase: "idle", turn: 0 };

export type PushToTalkEvent =
  /** Mic button or hotkey: open the mic, or — while recording — stop and transcribe. */
  | { type: "press" }
  /** Stop recording and transcribe (button toggle, max-length timer). */
  | { type: "release" }
  /** Escape: drop the capture, or abort a delivery that is still running. */
  | { type: "cancel" }
  /** Typed Enter. */
  | { type: "submit"; text: string }
  | { type: "mic-started"; turn: number }
  /** The mic did not open. No message = it declined quietly (it already told the user). */
  | { type: "mic-failed"; turn: number; message?: string }
  | { type: "transcribed"; turn: number; text: string }
  | { type: "transcribe-failed"; turn: number; message: string }
  | { type: "delivered"; turn: number }
  | { type: "deliver-failed"; turn: number; message: string };

export type PushToTalkReport = "error" | "ignored" | "cancelled";

export type PushToTalkEffect =
  | { type: "start-mic"; turn: number }
  | { type: "finish-mic"; turn: number }
  | { type: "cancel-mic" }
  | { type: "abort-turn"; turn: number }
  | { type: "deliver"; turn: number; text: string; source: PushToTalkSource }
  | { type: "report"; turn: number; kind: PushToTalkReport; message?: string };

export interface PushToTalkStep {
  state: PushToTalkState;
  effects: PushToTalkEffect[];
}

const idle = (turn: number): PushToTalkState => ({ phase: "idle", turn });

export function pushToTalkReducer(state: PushToTalkState, event: PushToTalkEvent): PushToTalkStep {
  const same = (effects: PushToTalkEffect[] = []): PushToTalkStep => ({ state, effects });
  const current = "turn" in event && event.turn === state.turn;

  switch (event.type) {
    case "press": {
      if (state.phase === "starting") return same();
      if (state.phase === "recording") return pushToTalkReducer(state, { type: "release" });
      const turn = state.turn + 1;
      const superseded: PushToTalkEffect[] =
        state.phase === "transcribing"
          ? [{ type: "cancel-mic" }, { type: "abort-turn", turn: state.turn }]
          : state.phase === "delivering"
            ? [{ type: "abort-turn", turn: state.turn }]
            : [];
      return { state: { phase: "starting", turn }, effects: [...superseded, { type: "start-mic", turn }] };
    }
    case "release":
      if (state.phase !== "recording") return same();
      return { state: { ...state, phase: "transcribing" }, effects: [{ type: "finish-mic", turn: state.turn }] };
    case "cancel":
      if (state.phase === "idle") return same();
      return {
        state: idle(state.turn),
        effects: [
          // A delivering turn already closed its mic; only its late result must be dropped.
          ...(state.phase === "delivering" ? [] : [{ type: "cancel-mic" } as const]),
          { type: "abort-turn", turn: state.turn },
          { type: "report", turn: state.turn, kind: "cancelled" },
        ],
      };
    case "submit": {
      if (state.phase !== "idle" || !event.text.trim()) return same();
      const turn = state.turn + 1;
      return {
        state: { phase: "delivering", turn },
        effects: [{ type: "deliver", turn, text: event.text, source: "typed" }],
      };
    }
    case "mic-started":
      // A mic that opens for a turn that is gone must be closed again, or it keeps listening.
      if (!current || state.phase !== "starting") return same([{ type: "cancel-mic" }]);
      return { state: { ...state, phase: "recording" }, effects: [] };
    case "mic-failed":
      if (!current || state.phase !== "starting") return same();
      return {
        state: idle(state.turn),
        effects: event.message ? [{ type: "report", turn: state.turn, kind: "error", message: event.message }] : [],
      };
    case "transcribed":
      if (!current || state.phase !== "transcribing") return same();
      if (!event.text.trim()) {
        return { state: idle(state.turn), effects: [{ type: "report", turn: state.turn, kind: "ignored" }] };
      }
      return {
        state: { ...state, phase: "delivering" },
        effects: [{ type: "deliver", turn: state.turn, text: event.text, source: "voice" }],
      };
    case "transcribe-failed":
      if (!current || state.phase !== "transcribing") return same();
      return {
        state: idle(state.turn),
        effects: [{ type: "report", turn: state.turn, kind: "error", message: event.message }],
      };
    case "delivered":
      if (!current || state.phase !== "delivering") return same();
      return { state: idle(state.turn), effects: [] };
    case "deliver-failed":
      if (!current || state.phase !== "delivering") return same();
      return {
        state: idle(state.turn),
        effects: [{ type: "report", turn: state.turn, kind: "error", message: event.message }],
      };
  }
}

/** A turn as the handlers see it. `signal` aborts when the turn is cancelled or superseded. */
export interface PushToTalkTurn {
  id: number;
  signal: AbortSignal;
  /** False once a newer turn started or this one was cancelled — check before applying a result. */
  isCurrent(): boolean;
}

/** What a mode plugs in. Every async step may throw; the session catches and reports it. */
export interface PushToTalkHandlers {
  /** Open the mic. Resolve false when it declined quietly (it already told the user why). */
  startMic(turn: PushToTalkTurn): Promise<boolean>;
  /** Stop recording; resolve the final transcript. */
  finishMic(turn: PushToTalkTurn): Promise<string>;
  /** Drop the capture without a transcript. */
  cancelMic(): void;
  /** Hand a finished utterance (spoken or typed) to the mode. Resolves when it has been handled. */
  deliver(text: string, turn: PushToTalkTurn, source: PushToTalkSource): Promise<void>;
  report(kind: PushToTalkReport, message?: string): void;
  /** Turn a thrown error into words for the user. Undefined (or no hook) = the error's message. */
  describeError?(error: unknown, stage: "mic" | "transcribe" | "deliver"): string | undefined;
}

export interface PushToTalkSessionOptions {
  /** A delivery still running after this long is aborted through its signal and reported. Default
   *  {@link DEFAULT_DELIVER_TIMEOUT_MS}. */
  deliverTimeoutMs?: number;
}

/** Above the slowest legitimate turn: NL parse + refine (15s each) plus an agent receipt (45s). */
export const DEFAULT_DELIVER_TIMEOUT_MS = 90_000;

export const DELIVER_TIMED_OUT_MESSAGE = "That took too long and was stopped — try again.";

export interface PushToTalkSession {
  getState(): PushToTalkState;
  subscribe(listener: () => void): () => void;
  press(): void;
  release(): void;
  cancel(): void;
  /** Typed submit. False when another turn is still in flight (the in-flight guard). */
  submit(text: string): boolean;
  /** Abort whatever is live and stop reacting. */
  dispose(): void;
}

export const messageOf = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : typeof error === "string" && error ? error : "Voice input failed.";

/**
 * Runs {@link pushToTalkReducer}: executes its effects through the handlers, feeds async results back
 * as events, and gives every turn an AbortSignal. Handlers are read through a getter on each use, so a
 * React owner can pass fresh closures every render.
 */
export function createPushToTalkSession(
  getHandlers: () => PushToTalkHandlers,
  options: PushToTalkSessionOptions = {},
): PushToTalkSession {
  const deliverTimeoutMs = options.deliverTimeoutMs ?? DEFAULT_DELIVER_TIMEOUT_MS;
  let state = INITIAL_PUSH_TO_TALK_STATE;
  let disposed = false;
  const listeners = new Set<() => void>();
  const controllers = new Map<number, AbortController>();

  const turnFor = (id: number): PushToTalkTurn => {
    let controller = controllers.get(id);
    if (!controller) {
      controller = new AbortController();
      controllers.set(id, controller);
    }
    const signal = controller.signal;
    return { id, signal, isCurrent: () => !disposed && state.turn === id && !signal.aborted };
  };

  const describe = (error: unknown, stage: "mic" | "transcribe" | "deliver") =>
    getHandlers().describeError?.(error, stage) ?? messageOf(error);

  const dispatch = (event: PushToTalkEvent) => {
    if (disposed) return;
    const step = pushToTalkReducer(state, event);
    const changed = step.state !== state;
    state = step.state;
    if (changed) for (const listener of listeners) listener();
    for (const effect of step.effects) run(effect);
    // A turn that settled no longer needs its controller: drop it WITHOUT aborting. Superseded and
    // cancelled turns were already aborted and dropped by their `abort-turn` effect.
    if (state.phase === "idle") controllers.delete(state.turn);
  };

  /** Call a handler now; a synchronous throw becomes a rejection like an async one. */
  const call = <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return Promise.resolve(step());
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const run = (effect: PushToTalkEffect) => {
    const handlers = getHandlers();
    switch (effect.type) {
      case "start-mic": {
        const turn = turnFor(effect.turn);
        void call(() => handlers.startMic(turn)).then(
          (started) => dispatch(started ? { type: "mic-started", turn: turn.id } : { type: "mic-failed", turn: turn.id }),
          (error: unknown) => dispatch({ type: "mic-failed", turn: turn.id, message: describe(error, "mic") }),
        );
        return;
      }
      case "finish-mic": {
        const turn = turnFor(effect.turn);
        void call(() => handlers.finishMic(turn)).then(
          (text) => dispatch({ type: "transcribed", turn: turn.id, text }),
          (error: unknown) => dispatch({ type: "transcribe-failed", turn: turn.id, message: describe(error, "transcribe") }),
        );
        return;
      }
      case "deliver": {
        const turn = turnFor(effect.turn);
        // The deadline aborts first, so the handler's model call stops; then the turn fails. Its late
        // settle is dropped by the reducer (the turn is no longer delivering).
        const deadline = setTimeout(() => {
          if (!turn.isCurrent()) return;
          controllers.get(turn.id)?.abort();
          dispatch({ type: "deliver-failed", turn: turn.id, message: DELIVER_TIMED_OUT_MESSAGE });
        }, deliverTimeoutMs);
        void call(() => handlers.deliver(effect.text, turn, effect.source))
          .finally(() => clearTimeout(deadline))
          .then(
            () => dispatch({ type: "delivered", turn: turn.id }),
            (error: unknown) => dispatch({ type: "deliver-failed", turn: turn.id, message: describe(error, "deliver") }),
          );
        return;
      }
      case "cancel-mic":
        try {
          handlers.cancelMic();
        } catch (error) {
          console.warn("[voice] push-to-talk cancelMic failed:", error);
        }
        return;
      case "abort-turn":
        // Not via turnFor: aborting a turn that has no controller yet must not create one.
        controllers.get(effect.turn)?.abort();
        controllers.delete(effect.turn);
        return;
      case "report":
        handlers.report(effect.kind, effect.message);
        return;
    }
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    press: () => dispatch({ type: "press" }),
    release: () => dispatch({ type: "release" }),
    cancel: () => dispatch({ type: "cancel" }),
    submit(text) {
      const before = state;
      dispatch({ type: "submit", text });
      return state !== before;
    },
    dispose() {
      if (disposed) return;
      const capturing = state.phase === "starting" || state.phase === "recording" || state.phase === "transcribing";
      disposed = true;
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      if (capturing) run({ type: "cancel-mic" });
      // End idle, so anyone waiting for the session to rest is released.
      if (state.phase !== "idle") {
        state = idle(state.turn);
        for (const listener of listeners) listener();
      }
      listeners.clear();
    },
  };
}
