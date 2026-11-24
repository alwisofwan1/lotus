import { describe, it, expect, vi } from "vitest";
import {
  INITIAL_PUSH_TO_TALK_STATE,
  createPushToTalkSession,
  type PushToTalkHandlers,
  type PushToTalkTurn,
  pushToTalkReducer,
  type PushToTalkEffect,
  type PushToTalkEvent,
  type PushToTalkState,
} from "../push-to-talk-session";

/** Run a sequence of events; return the final state and every effect, in order. */
function run(events: PushToTalkEvent[], from: PushToTalkState = INITIAL_PUSH_TO_TALK_STATE) {
  let state = from;
  const effects: PushToTalkEffect[] = [];
  for (const event of events) {
    const step = pushToTalkReducer(state, event);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

describe("Push-to-Talk session reducer", () => {
  it("press → mic opens → release → transcript → delivers the text once", () => {
    const { state, effects } = run([
      { type: "press" },
      { type: "mic-started", turn: 1 },
      { type: "release" },
      { type: "transcribed", turn: 1, text: "open three agents" },
    ]);
    expect(effects).toEqual([
      { type: "start-mic", turn: 1 },
      { type: "finish-mic", turn: 1 },
      { type: "deliver", turn: 1, text: "open three agents", source: "voice" },
    ]);
    expect(state.phase).toBe("delivering");
    expect(run([{ type: "delivered", turn: 1 }], state).state.phase).toBe("idle");
  });

  it("a second press while recording acts as release (toggle mic)", () => {
    const { effects } = run([{ type: "press" }, { type: "mic-started", turn: 1 }, { type: "press" }]);
    expect(effects.at(-1)).toEqual({ type: "finish-mic", turn: 1 });
  });

  it("typed submit twice fast delivers only once", () => {
    const { effects } = run([
      { type: "submit", text: "open three agents" },
      { type: "submit", text: "open three agents" },
    ]);
    expect(effects).toEqual([{ type: "deliver", turn: 1, text: "open three agents", source: "typed" }]);
  });

  it("typed submit while a voice turn delivers is ignored", () => {
    const { effects } = run([
      { type: "press" },
      { type: "mic-started", turn: 1 },
      { type: "release" },
      { type: "transcribed", turn: 1, text: "close Atlas" },
      { type: "submit", text: "close Atlas" },
    ]);
    expect(effects.filter((e) => e.type === "deliver")).toHaveLength(1);
  });

  it("typed submit is accepted again once the last delivery settled, even if it failed", () => {
    const { effects } = run([
      { type: "submit", text: "a" },
      { type: "deliver-failed", turn: 1, message: "model down" },
      { type: "submit", text: "b" },
    ]);
    expect(effects).toEqual([
      { type: "deliver", turn: 1, text: "a", source: "typed" },
      { type: "report", turn: 1, kind: "error", message: "model down" },
      { type: "deliver", turn: 2, text: "b", source: "typed" },
    ]);
  });

  it("Escape while recording cancels: mic closed, turn aborted, nothing delivered", () => {
    const { state, effects } = run([
      { type: "press" },
      { type: "mic-started", turn: 1 },
      { type: "cancel" },
      { type: "transcribed", turn: 1, text: "late words" },
    ]);
    expect(effects).toEqual([
      { type: "start-mic", turn: 1 },
      { type: "cancel-mic" },
      { type: "abort-turn", turn: 1 },
      { type: "report", turn: 1, kind: "cancelled" },
    ]);
    expect(state.phase).toBe("idle");
  });

  it("Escape while the mic is still opening also cancels, and a late mic start is closed", () => {
    const { effects } = run([{ type: "press" }, { type: "cancel" }, { type: "mic-started", turn: 1 }]);
    expect(effects).toEqual([
      { type: "start-mic", turn: 1 },
      { type: "cancel-mic" },
      { type: "abort-turn", turn: 1 },
      { type: "report", turn: 1, kind: "cancelled" },
      { type: "cancel-mic" },
    ]);
  });

  it("Escape while a turn delivers aborts it, so its late receipt never applies; the mic stays closed", () => {
    const { state, effects } = run([
      { type: "submit", text: "rewrite this" },
      { type: "cancel" },
      { type: "delivered", turn: 1 },
    ]);
    expect(effects).toEqual([
      { type: "deliver", turn: 1, text: "rewrite this", source: "typed" },
      { type: "abort-turn", turn: 1 },
      { type: "report", turn: 1, kind: "cancelled" },
    ]);
    expect(state.phase).toBe("idle");
  });

  it("an empty or whitespace transcript is ignored, not delivered", () => {
    const { state, effects } = run([
      { type: "press" },
      { type: "mic-started", turn: 1 },
      { type: "release" },
      { type: "transcribed", turn: 1, text: "   " },
    ]);
    expect(effects.at(-1)).toEqual({ type: "report", turn: 1, kind: "ignored" });
    expect(state.phase).toBe("idle");
  });

  it("a new recording while the old turn still transcribes supersedes it; the old result never applies", () => {
    const { effects } = run([
      { type: "press" },
      { type: "mic-started", turn: 1 },
      { type: "release" },
      { type: "press" },
      { type: "transcribed", turn: 1, text: "old words" },
      { type: "mic-started", turn: 2 },
      { type: "release" },
      { type: "transcribed", turn: 2, text: "new words" },
    ]);
    expect(effects).toEqual([
      { type: "start-mic", turn: 1 },
      { type: "finish-mic", turn: 1 },
      { type: "cancel-mic" },
      { type: "abort-turn", turn: 1 },
      { type: "start-mic", turn: 2 },
      { type: "finish-mic", turn: 2 },
      { type: "deliver", turn: 2, text: "new words", source: "voice" },
    ]);
  });

  it("a new recording while the old turn still delivers aborts the old delivery", () => {
    const { effects } = run([
      { type: "submit", text: "rewrite this" },
      { type: "press" },
      { type: "delivered", turn: 1 },
    ]);
    expect(effects).toEqual([
      { type: "deliver", turn: 1, text: "rewrite this", source: "typed" },
      { type: "abort-turn", turn: 1 },
      { type: "start-mic", turn: 2 },
    ]);
  });

  it("a failed mic start reports the reason and returns to idle", () => {
    const { state, effects } = run([{ type: "press" }, { type: "mic-failed", turn: 1, message: "Microphone permission denied" }]);
    expect(effects.at(-1)).toEqual({ type: "report", turn: 1, kind: "error", message: "Microphone permission denied" });
    expect(state.phase).toBe("idle");
  });

  it("a mic that did not open (no message) returns to idle silently", () => {
    const { state, effects } = run([{ type: "press" }, { type: "mic-failed", turn: 1 }]);
    expect(effects).toEqual([{ type: "start-mic", turn: 1 }]);
    expect(state.phase).toBe("idle");
  });

  it("a failed transcription reports and returns to idle", () => {
    const { state, effects } = run([
      { type: "press" },
      { type: "mic-started", turn: 1 },
      { type: "release" },
      { type: "transcribe-failed", turn: 1, message: "STT finalization timed out" },
    ]);
    expect(effects.at(-1)).toEqual({ type: "report", turn: 1, kind: "error", message: "STT finalization timed out" });
    expect(state.phase).toBe("idle");
  });

  it("presses while the mic is opening are ignored", () => {
    const { effects } = run([{ type: "press" }, { type: "press" }]);
    expect(effects).toEqual([{ type: "start-mic", turn: 1 }]);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Handlers whose async steps finish only when the test says so. */
function scriptedHandlers() {
  const mics: ReturnType<typeof deferred<boolean>>[] = [];
  const transcripts: ReturnType<typeof deferred<string>>[] = [];
  const deliveries: { text: string; source: string; turn: PushToTalkTurn; done: ReturnType<typeof deferred<void>> }[] = [];
  const reports: { kind: string; message?: string }[] = [];
  let micCancels = 0;
  const handlers: PushToTalkHandlers = {
    startMic: () => {
      const d = deferred<boolean>();
      mics.push(d);
      return d.promise;
    },
    finishMic: () => {
      const d = deferred<string>();
      transcripts.push(d);
      return d.promise;
    },
    cancelMic: () => {
      micCancels += 1;
    },
    deliver: (text, turn, source) => {
      const done = deferred<void>();
      deliveries.push({ text, source, turn, done });
      return done.promise;
    },
    report: (kind, message) => {
      reports.push(message === undefined ? { kind } : { kind, message });
    },
  };
  return { handlers, mics, transcripts, deliveries, reports, micCancels: () => micCancels };
}

describe("Push-to-Talk session runtime", () => {
  it("runs one spoken turn through the handlers and ends idle", async () => {
    const h = scriptedHandlers();
    const session = createPushToTalkSession(() => h.handlers);
    session.press();
    h.mics[0].resolve(true);
    await flush();
    expect(session.getState().phase).toBe("recording");
    session.release();
    h.transcripts[0].resolve("open three agents");
    await flush();
    expect(h.deliveries.map((d) => [d.text, d.source])).toEqual([["open three agents", "voice"]]);
    h.deliveries[0].done.resolve();
    await flush();
    expect(session.getState().phase).toBe("idle");
  });

  it("two fast typed submits deliver once; the second is refused", () => {
    const h = scriptedHandlers();
    const session = createPushToTalkSession(() => h.handlers);
    expect(session.submit("close Atlas")).toBe(true);
    expect(session.submit("close Atlas")).toBe(false);
    expect(h.deliveries).toHaveLength(1);
  });

  it("a superseded turn's signal aborts, so its model call can stop and its result is not applied", async () => {
    const h = scriptedHandlers();
    const session = createPushToTalkSession(() => h.handlers);
    session.submit("rewrite this as bullets");
    const old = h.deliveries[0].turn;
    expect(old.signal.aborted).toBe(false);
    expect(old.isCurrent()).toBe(true);
    session.press();
    expect(old.signal.aborted).toBe(true);
    expect(old.isCurrent()).toBe(false);
  });

  it("Escape aborts the turn and closes the mic", async () => {
    const h = scriptedHandlers();
    const session = createPushToTalkSession(() => h.handlers);
    session.press();
    h.mics[0].resolve(true);
    await flush();
    session.cancel();
    expect(h.micCancels()).toBe(1);
    expect(h.reports).toEqual([{ kind: "cancelled" }]);
    h.transcripts[0]?.resolve("late");
    await flush();
    expect(h.deliveries).toHaveLength(0);
  });

  it("a delivery that throws is caught, reported, and the session is usable again", async () => {
    const h = scriptedHandlers();
    const session = createPushToTalkSession(() => h.handlers);
    session.submit("open three agents");
    h.deliveries[0].done.reject(new Error("model unavailable"));
    await flush();
    expect(h.reports).toEqual([{ kind: "error", message: "model unavailable" }]);
    expect(session.getState().phase).toBe("idle");
    expect(session.submit("open two agents")).toBe(true);
  });

  it("a mic start that throws is reported through describeError", async () => {
    const h = scriptedHandlers();
    const session = createPushToTalkSession(() => ({
      ...h.handlers,
      describeError: (err) => `mic: ${(err as Error).name}`,
    }));
    session.press();
    h.mics[0].reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    await flush();
    expect(h.reports).toEqual([{ kind: "error", message: "mic: NotAllowedError" }]);
    expect(session.getState().phase).toBe("idle");
  });

  it("notifies subscribers on every phase change", async () => {
    const h = scriptedHandlers();
    const session = createPushToTalkSession(() => h.handlers);
    const phases: string[] = [];
    session.subscribe(() => phases.push(session.getState().phase));
    session.press();
    h.mics[0].resolve(false);
    await flush();
    expect(phases).toEqual(["starting", "idle"]);
  });

  it("a delivery that runs past its deadline is aborted through its signal and reported", async () => {
    vi.useFakeTimers();
    try {
      const h = scriptedHandlers();
      const session = createPushToTalkSession(() => h.handlers, { deliverTimeoutMs: 1_000 });
      session.submit("rewrite this as bullets");
      const turn = h.deliveries[0].turn;
      await vi.advanceTimersByTimeAsync(999);
      expect(turn.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(turn.signal.aborted).toBe(true);
      expect(turn.isCurrent()).toBe(false);
      expect(h.reports).toEqual([{ kind: "error", message: "That took too long and was stopped — try again." }]);
      expect(session.getState().phase).toBe("idle");
      h.deliveries[0].done.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.submit("next")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a delivery that settles in time leaves no deadline behind", async () => {
    vi.useFakeTimers();
    try {
      const h = scriptedHandlers();
      const session = createPushToTalkSession(() => h.handlers, { deliverTimeoutMs: 1_000 });
      session.submit("a");
      h.deliveries[0].done.resolve();
      await vi.advanceTimersByTimeAsync(0);
      session.submit("b");
      await vi.advanceTimersByTimeAsync(600);
      h.deliveries[1].done.resolve();
      await vi.advanceTimersByTimeAsync(600);
      expect(h.reports).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose ends the session idle, so a caller waiting for it to rest is released", () => {
    const h = scriptedHandlers();
    const session = createPushToTalkSession(() => h.handlers);
    const phases: string[] = [];
    session.subscribe(() => phases.push(session.getState().phase));
    session.submit("a");
    session.dispose();
    expect(phases).toEqual(["delivering", "idle"]);
  });

  it("dispose aborts the live turn and closes the mic", async () => {
    const h = scriptedHandlers();
    const session = createPushToTalkSession(() => h.handlers);
    session.press();
    h.mics[0].resolve(true);
    await flush();
    session.dispose();
    expect(h.micCancels()).toBe(1);
    h.transcripts[0]?.resolve("x");
    await flush();
    expect(h.deliveries).toHaveLength(0);
  });
});
