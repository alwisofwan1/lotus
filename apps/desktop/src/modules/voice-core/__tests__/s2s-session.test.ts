import { describe, expect, it } from "vitest";
import { initialS2sSession, reduceS2sSession } from "../s2s-session";

describe("reduceS2sSession", () => {
  it("opens: idle + open → connecting, requests the transport connect", () => {
    const step = reduceS2sSession(initialS2sSession(), { type: "open" });
    expect(step.session.phase).toBe("connecting");
    expect(step.effects).toContainEqual({ type: "connect" });
  });

  it("goes live: connecting + ready → listening, starts mic capture", () => {
    const step = reduceS2sSession({ phase: "connecting", turn: 0 }, { type: "ready" });
    expect(step.session.phase).toBe("listening");
    expect(step.effects).toContainEqual({ type: "startCapture" });
  });

  it("user starts speaking: listening + userSpeechStart → user, turn increments", () => {
    const step = reduceS2sSession({ phase: "listening", turn: 0 }, { type: "userSpeechStart" });
    expect(step.session.phase).toBe("user");
    expect(step.session.turn).toBe(1);
  });

  it("user stops speaking: user + userSpeechEnd → thinking (awaiting agent audio)", () => {
    const step = reduceS2sSession({ phase: "user", turn: 1 }, { type: "userSpeechEnd" });
    expect(step.session.phase).toBe("thinking");
  });

  it("agent replies: thinking + agentAudioStart → agent", () => {
    const step = reduceS2sSession({ phase: "thinking", turn: 1 }, { type: "agentAudioStart" });
    expect(step.session.phase).toBe("agent");
  });

  it("agent finishes: agent + agentAudioEnd → listening (floor back to user)", () => {
    const step = reduceS2sSession({ phase: "agent", turn: 1 }, { type: "agentAudioEnd" });
    expect(step.session.phase).toBe("listening");
  });

  it("barge-in: user speaks while agent is talking → interrupts playback, floor to user, turn++", () => {
    const step = reduceS2sSession({ phase: "agent", turn: 1 }, { type: "bargeIn" });
    expect(step.session.phase).toBe("user");
    expect(step.session.turn).toBe(2);
    expect(step.effects).toContainEqual({ type: "interruptPlayback" });
  });

  it("barge-in only matters while the agent is speaking: ignored when just listening", () => {
    const step = reduceS2sSession({ phase: "listening", turn: 1 }, { type: "bargeIn" });
    expect(step.session.phase).toBe("listening");
    expect(step.session.turn).toBe(1);
    expect(step.effects).toEqual([]);
  });

  it("error from any live phase → error, captures the message, tears down", () => {
    const step = reduceS2sSession({ phase: "agent", turn: 3 }, { type: "error", message: "ws closed" });
    expect(step.session.phase).toBe("error");
    expect(step.session.error).toBe("ws closed");
    expect(step.effects).toContainEqual({ type: "teardown" });
  });

  it("close from any live phase → closed, tears down", () => {
    const step = reduceS2sSession({ phase: "listening", turn: 3 }, { type: "close" });
    expect(step.session.phase).toBe("closed");
    expect(step.effects).toContainEqual({ type: "teardown" });
  });

  it("is inert once closed: further events produce no transitions or effects", () => {
    const closed = reduceS2sSession({ phase: "listening", turn: 1 }, { type: "close" }).session;
    const step = reduceS2sSession(closed, { type: "userSpeechStart" });
    expect(step.session).toEqual(closed);
    expect(step.effects).toEqual([]);
  });

  it("close is honoured from the terminal error phase → closed, so the UI can leave the error surface", () => {
    const errored = reduceS2sSession({ phase: "agent", turn: 2 }, { type: "error", message: "boom" }).session;
    expect(errored.phase).toBe("error");
    const step = reduceS2sSession(errored, { type: "close" });
    expect(step.session.phase).toBe("closed");
    // error already tore down, so closing from it needs no further effect (no double teardown).
    expect(step.effects).toEqual([]);
  });

  it("close from closed is a no-op (idempotent, no teardown re-fire)", () => {
    const closed = reduceS2sSession({ phase: "listening", turn: 1 }, { type: "close" }).session;
    const step = reduceS2sSession(closed, { type: "close" });
    expect(step.session).toEqual(closed);
    expect(step.effects).toEqual([]);
  });

  it("non-close events stay inert in the error phase", () => {
    const errored = reduceS2sSession({ phase: "agent", turn: 1 }, { type: "error", message: "x" }).session;
    const step = reduceS2sSession(errored, { type: "ready" });
    expect(step.session).toEqual(errored);
    expect(step.effects).toEqual([]);
  });

  describe("connection drop → one silent reconnect", () => {
    it.each(["listening", "user", "thinking", "agent"] as const)(
      "a drop while %s closes the mic and reconnects once, keeping the turn count",
      (phase) => {
        const step = reduceS2sSession({ phase, turn: 3 }, { type: "drop", message: "socket closed" });
        expect(step.session).toEqual({ phase: "reconnecting", turn: 3 });
        expect(step.effects).toEqual([{ type: "stopCapture" }, { type: "reconnect" }]);
      },
    );

    it("the reconnected socket going ready resumes listening and reopens the mic", () => {
      const step = reduceS2sSession({ phase: "reconnecting", turn: 3 }, { type: "ready" });
      expect(step.session.phase).toBe("listening");
      expect(step.effects).toEqual([{ type: "startCapture" }]);
    });

    it("speech events from the dead socket are ignored while reconnecting", () => {
      for (const type of ["userSpeechStart", "userSpeechEnd", "agentAudioStart", "agentAudioEnd", "bargeIn"] as const) {
        const step = reduceS2sSession({ phase: "reconnecting", turn: 3 }, { type });
        expect(step).toEqual({ session: { phase: "reconnecting", turn: 3 }, effects: [] });
      }
    });

    it("a second drop while reconnecting is an error with the reason, and tears down", () => {
      const step = reduceS2sSession({ phase: "reconnecting", turn: 3 }, { type: "drop", message: "network unreachable" });
      expect(step.session.phase).toBe("error");
      expect(step.session.error).toBe("Live Voice lost its connection and could not reconnect: network unreachable");
      expect(step.effects).toEqual([{ type: "teardown" }]);
    });

    it("a drop before the first connect finished is an error, not a reconnect", () => {
      const step = reduceS2sSession({ phase: "connecting", turn: 0 }, { type: "drop", message: "refused" });
      expect(step.session.phase).toBe("error");
      expect(step.effects).toEqual([{ type: "teardown" }]);
    });

    it("after a successful reconnect, a later drop gets its own one reconnect", () => {
      let session = reduceS2sSession({ phase: "listening", turn: 1 }, { type: "drop", message: "a" }).session;
      session = reduceS2sSession(session, { type: "ready" }).session;
      const step = reduceS2sSession(session, { type: "drop", message: "b" });
      expect(step.session.phase).toBe("reconnecting");
    });

    it("End while reconnecting closes and tears down", () => {
      const step = reduceS2sSession({ phase: "reconnecting", turn: 1 }, { type: "close" });
      expect(step.session.phase).toBe("closed");
      expect(step.effects).toEqual([{ type: "teardown" }]);
    });

    it("a drop after the session ended is ignored", () => {
      for (const phase of ["idle", "closed", "error"] as const) {
        const step = reduceS2sSession({ phase, turn: 1 }, { type: "drop", message: "late" });
        expect(step.effects).toEqual([]);
        expect(step.session.phase).toBe(phase);
      }
    });
  });
});
