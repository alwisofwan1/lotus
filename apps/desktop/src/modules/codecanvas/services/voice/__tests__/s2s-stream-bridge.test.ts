import { describe, expect, it } from "vitest";
import { translateS2sStreamEvent } from "../s2s-stream-bridge";

describe("translateS2sStreamEvent", () => {
  it("first audio delta while thinking → agentAudioStart and plays the audio", () => {
    const out = translateS2sStreamEvent({ kind: "audioDelta", audioBase64: "QUJD" }, "thinking");
    expect(out.event).toEqual({ type: "agentAudioStart" });
    expect(out.playAudio).toBe("QUJD");
  });

  it("subsequent audio deltas while the agent speaks just play — no repeated agentAudioStart", () => {
    const out = translateS2sStreamEvent({ kind: "audioDelta", audioBase64: "REVG" }, "agent");
    expect(out.event).toBeNull();
    expect(out.playAudio).toBe("REVG");
  });

  it("user speech while the agent is talking is a barge-in", () => {
    const out = translateS2sStreamEvent({ kind: "userSpeechStart" }, "agent");
    expect(out.event).toEqual({ type: "bargeIn" });
  });

  it("user speech while listening is a normal turn start", () => {
    const out = translateS2sStreamEvent({ kind: "userSpeechStart" }, "listening");
    expect(out.event).toEqual({ type: "userSpeechStart" });
  });

  it("maps userSpeechEnd and agentAudioEnd straight through", () => {
    expect(translateS2sStreamEvent({ kind: "userSpeechEnd" }, "user").event).toEqual({
      type: "userSpeechEnd",
    });
    expect(translateS2sStreamEvent({ kind: "agentAudioEnd" }, "agent").event).toEqual({
      type: "agentAudioEnd",
    });
  });

  it("responseDone stays a transport boundary without changing the speaking floor", () => {
    expect(translateS2sStreamEvent({ kind: "responseDone" }, "thinking")).toEqual({
      event: null,
      playAudio: null,
      transcriptionFailure: null,
      transcriptSegment: null,
      transcript: null,
      toolCall: null,
    });
  });

  it("transcript is display-only — it never drives the state machine", () => {
    const out = translateS2sStreamEvent(
      { kind: "transcript", text: "hello", isFinal: true },
      "agent",
    );
    expect(out.event).toBeNull();
    expect(out.transcript).toEqual({ text: "hello", isFinal: true });
  });

  it("surfaces a tool call with parsed arguments and drives no state change", () => {
    const out = translateS2sStreamEvent(
      { kind: "toolCall", callId: "c1", name: "spawn_agent", arguments: '{"brief":"go"}' },
      "agent",
    );
    expect(out.event).toBeNull();
    expect(out.toolCall).toEqual({ callId: "c1", name: "spawn_agent", args: { brief: "go" } });
  });

  it("tolerates malformed tool-call arguments by falling back to empty args", () => {
    const out = translateS2sStreamEvent(
      { kind: "toolCall", callId: "c1", name: "spawn_agent", arguments: "not json" },
      "agent",
    );
    expect(out.toolCall).toEqual({ callId: "c1", name: "spawn_agent", args: {} });
  });

  it("maps provider errors to errors, and an unexpected transport close to a drop (one reconnect)", () => {
    expect(translateS2sStreamEvent({ kind: "error", message: "boom" }, "agent").event).toEqual({
      type: "error",
      message: "boom",
    });
    expect(translateS2sStreamEvent({ kind: "closed" }, "listening").event).toEqual({
      type: "drop",
      message: "Realtime voice connection closed unexpectedly.",
    });
  });

  it("a transport read error (network loss) is a drop, not a fatal error — Rust sends it just before `closed`", () => {
    expect(translateS2sStreamEvent({ kind: "error", message: "realtime stream error: Connection reset by peer" }, "listening").event).toEqual({
      type: "drop",
      message: "realtime stream error: Connection reset by peer",
    });
  });

  it("ignores transport closed after terminal phases so the live voice surface does not resurrect", () => {
    expect(translateS2sStreamEvent({ kind: "closed" }, "error").event).toBeNull();
    expect(translateS2sStreamEvent({ kind: "closed" }, "closed").event).toBeNull();
  });

  it("carries itemId/contentIndex through so the accumulator can replace-by-item", () => {
    const out = translateS2sStreamEvent(
      { kind: "transcript", text: "hola", isFinal: true, speaker: "user", itemId: "itm_1", contentIndex: 0 },
      "listening",
    );
    expect(out.transcript).toEqual({
      text: "hola",
      isFinal: true,
      speaker: "user",
      itemId: "itm_1",
      contentIndex: 0,
    });
  });

  it("omits itemId/contentIndex when the provider did not send them", () => {
    const out = translateS2sStreamEvent({ kind: "transcript", text: "hi", isFinal: false }, "listening");
    expect(out.transcript).toEqual({ text: "hi", isFinal: false });
  });

  // Only a cumulative update may be treated as authoritative text while non-final. An incremental
  // delta appended verbatim is exactly how the quadratic duplication bug returns, so the flag must
  // reach the consumer and must stay ABSENT (not `false`) for incremental fragments.
  it("marks a cumulative update and leaves an incremental delta unflagged", () => {
    const cumulative = translateS2sStreamEvent(
      { kind: "transcript", text: "tolong kirim", isFinal: false, speaker: "user", cumulative: true },
      "listening",
    );
    expect(cumulative.transcript).toEqual({
      text: "tolong kirim",
      isFinal: false,
      speaker: "user",
      cumulative: true,
    });

    const incremental = translateS2sStreamEvent(
      { kind: "transcript", text: "kirim", isFinal: false, speaker: "user" },
      "listening",
    );
    expect(incremental.transcript).toEqual({ text: "kirim", isFinal: false, speaker: "user" });
  });

  // A failed transcription is per-item and recoverable. Mapping it to the reducer's `error` event
  // would tear the whole duplex session down (reduceS2sSession's `error` case returns a teardown
  // effect), so it must surface as data — never as a state-machine error.
  it("surfaces a failed transcription without producing a session-killing error event", () => {
    const out = translateS2sStreamEvent(
      { kind: "transcriptionFailed", itemId: "itm_9", code: "transcription_failed", message: "service down" },
      "listening",
    );
    expect(out.event).toBeNull();
    expect(out.transcript).toBeNull();
    expect(out.transcriptionFailure).toEqual({
      itemId: "itm_9",
      code: "transcription_failed",
      message: "service down",
    });
  });

  it("passes a transcription segment through as data without touching session state", () => {
    const out = translateS2sStreamEvent(
      { kind: "transcriptionSegment", id: "seg_1", start: 0.5, end: 1.25, speaker: "user", text: "halo" },
      "listening",
    );
    expect(out.event).toBeNull();
    expect(out.transcriptSegment).toEqual({
      id: "seg_1",
      start: 0.5,
      end: 1.25,
      speaker: "user",
      text: "halo",
    });
  });
});
