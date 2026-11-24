import { describe, expect, it } from "vitest";
import {
  beginAssistantAudioItem,
  decideBargeInTruncate,
  initialS2sTruncatePolicyState,
  markAssistantAudioItemComplete,
  markTruncateIssued,
  pcm16BytesToMs,
  pcm16MsToBytes,
  recordEnqueuedAudioBytes,
  recordPlayedAudioBytes,
  type S2sTruncatePolicyState,
} from "../s2s-truncate-policy";

const RATE = 24000;

describe("pcm16BytesToMs", () => {
  it("converts one full second of mono PCM16 @ 24kHz", () => {
    // 24000 samples/sec * 2 bytes/sample = 48000 bytes/sec.
    expect(pcm16BytesToMs(48000, RATE)).toBe(1000);
  });

  it("converts a half second", () => {
    expect(pcm16BytesToMs(24000, RATE)).toBe(500);
  });

  it("drops a non-frame-aligned trailing byte instead of producing a fractional-sample duration", () => {
    // 4801 bytes is not a whole number of 2-byte samples. The trailing byte must be dropped
    // (floor(4801/2) = 2400 samples), NOT treated as half a sample — which would otherwise yield
    // 100.02083...ms instead of the exact 100ms of 2400 whole samples.
    expect(pcm16BytesToMs(4801, RATE)).toBe(100);
  });

  it("clamps negative byte counts to 0ms", () => {
    expect(pcm16BytesToMs(-100, RATE)).toBe(0);
  });

  it("returns 0ms for a byte count too small for one sample", () => {
    expect(pcm16BytesToMs(1, RATE)).toBe(0);
  });
});

describe("pcm16MsToBytes", () => {
  it("converts a half second back to bytes", () => {
    expect(pcm16MsToBytes(500, RATE)).toBe(24000);
  });

  it("floors a non-integer ms input to a whole sample count", () => {
    // 10.9ms @ 24kHz = 261.6 samples -> floor to 261 samples -> 522 bytes.
    expect(pcm16MsToBytes(10.9, RATE)).toBe(522);
  });

  it("clamps negative ms to 0 bytes", () => {
    expect(pcm16MsToBytes(-5, RATE)).toBe(0);
  });
});

describe("s2sTruncatePolicyState transitions", () => {
  it("starts with no assistant item in flight", () => {
    const state = initialS2sTruncatePolicyState();
    expect(state).toEqual({
      itemId: null,
      enqueuedBytes: 0,
      playedBytes: 0,
      completed: false,
      truncatedItemId: null,
    });
  });

  it("beginAssistantAudioItem resets per-item counters for the new item", () => {
    let state = initialS2sTruncatePolicyState();
    state = beginAssistantAudioItem(state, "item-1");
    state = recordEnqueuedAudioBytes(state, "item-1", 48000);
    state = recordPlayedAudioBytes(state, "item-1", 24000);

    state = beginAssistantAudioItem(state, "item-2");

    expect(state.itemId).toBe("item-2");
    expect(state.enqueuedBytes).toBe(0);
    expect(state.playedBytes).toBe(0);
    expect(state.completed).toBe(false);
  });

  it("recordEnqueuedAudioBytes accumulates for the current item", () => {
    let state = beginAssistantAudioItem(initialS2sTruncatePolicyState(), "item-1");
    state = recordEnqueuedAudioBytes(state, "item-1", 1000);
    state = recordEnqueuedAudioBytes(state, "item-1", 2000);
    expect(state.enqueuedBytes).toBe(3000);
  });

  it("recordEnqueuedAudioBytes ignores events for a stale itemId", () => {
    const state = beginAssistantAudioItem(initialS2sTruncatePolicyState(), "item-current");
    const unchanged = recordEnqueuedAudioBytes(state, "item-old", 5000);
    expect(unchanged).toEqual(state);
  });

  it("recordEnqueuedAudioBytes ignores zero/negative byte lengths", () => {
    const state = beginAssistantAudioItem(initialS2sTruncatePolicyState(), "item-1");
    expect(recordEnqueuedAudioBytes(state, "item-1", 0)).toEqual(state);
    expect(recordEnqueuedAudioBytes(state, "item-1", -10)).toEqual(state);
  });

  it("recordPlayedAudioBytes accumulates for the current item", () => {
    let state = beginAssistantAudioItem(initialS2sTruncatePolicyState(), "item-1");
    state = recordEnqueuedAudioBytes(state, "item-1", 48000);
    state = recordPlayedAudioBytes(state, "item-1", 10000);
    state = recordPlayedAudioBytes(state, "item-1", 5000);
    expect(state.playedBytes).toBe(15000);
  });

  it("recordPlayedAudioBytes ignores events for a stale itemId", () => {
    const state = beginAssistantAudioItem(initialS2sTruncatePolicyState(), "item-current");
    const unchanged = recordPlayedAudioBytes(state, "item-old", 5000);
    expect(unchanged).toEqual(state);
  });

  it("recordPlayedAudioBytes ignores zero/negative byte lengths", () => {
    const state = beginAssistantAudioItem(initialS2sTruncatePolicyState(), "item-1");
    expect(recordPlayedAudioBytes(state, "item-1", 0)).toEqual(state);
    expect(recordPlayedAudioBytes(state, "item-1", -1)).toEqual(state);
  });

  it("recordPlayedAudioBytes clamps played bytes to never exceed enqueued bytes", () => {
    let state = beginAssistantAudioItem(initialS2sTruncatePolicyState(), "item-1");
    state = recordEnqueuedAudioBytes(state, "item-1", 1000);
    state = recordPlayedAudioBytes(state, "item-1", 999999);
    expect(state.playedBytes).toBe(1000);
  });

  it("markAssistantAudioItemComplete sets completed and fills playedBytes to enqueuedBytes", () => {
    let state = beginAssistantAudioItem(initialS2sTruncatePolicyState(), "item-1");
    state = recordEnqueuedAudioBytes(state, "item-1", 48000);
    state = recordPlayedAudioBytes(state, "item-1", 40000);

    state = markAssistantAudioItemComplete(state, "item-1");

    expect(state.completed).toBe(true);
    expect(state.playedBytes).toBe(48000);
  });

  it("markAssistantAudioItemComplete ignores a stale itemId", () => {
    const state = beginAssistantAudioItem(initialS2sTruncatePolicyState(), "item-current");
    const unchanged = markAssistantAudioItemComplete(state, "item-old");
    expect(unchanged).toEqual(state);
  });

  it("markTruncateIssued records the truncated item for the current itemId only", () => {
    const state = beginAssistantAudioItem(initialS2sTruncatePolicyState(), "item-1");
    const marked = markTruncateIssued(state, "item-1");
    expect(marked.truncatedItemId).toBe("item-1");

    const unmarked = markTruncateIssued(state, "item-other");
    expect(unmarked).toEqual(state);
  });
});

describe("decideBargeInTruncate", () => {
  function playingState(itemId: string, enqueuedBytes: number, playedBytes: number): S2sTruncatePolicyState {
    let state = beginAssistantAudioItem(initialS2sTruncatePolicyState(), itemId);
    state = recordEnqueuedAudioBytes(state, itemId, enqueuedBytes);
    state = recordPlayedAudioBytes(state, itemId, playedBytes);
    return state;
  }

  it("truncates at the played duration when audio was partially played", () => {
    const state = playingState("item-1", 48000, 24000); // 1000ms enqueued, 500ms played
    const decision = decideBargeInTruncate(state, RATE);
    expect(decision).toEqual({ shouldTruncate: true, itemId: "item-1", audioEndMs: 500 });
  });

  it("does not truncate when no assistant item is in flight", () => {
    const decision = decideBargeInTruncate(initialS2sTruncatePolicyState(), RATE);
    expect(decision).toEqual({ shouldTruncate: false });
  });

  it("does not truncate when the item already finished playing completely", () => {
    let state = beginAssistantAudioItem(initialS2sTruncatePolicyState(), "item-1");
    state = recordEnqueuedAudioBytes(state, "item-1", 48000);
    state = markAssistantAudioItemComplete(state, "item-1");

    const decision = decideBargeInTruncate(state, RATE);
    expect(decision).toEqual({ shouldTruncate: false });
  });

  it("does not truncate when the item id is unknown", () => {
    let state = beginAssistantAudioItem(initialS2sTruncatePolicyState(), null);
    state = recordEnqueuedAudioBytes(state, null, 48000);
    state = recordPlayedAudioBytes(state, null, 24000);

    const decision = decideBargeInTruncate(state, RATE);
    expect(decision).toEqual({ shouldTruncate: false });
  });

  it("does not truncate when played duration is 0", () => {
    const state = playingState("item-1", 48000, 0);
    const decision = decideBargeInTruncate(state, RATE);
    expect(decision).toEqual({ shouldTruncate: false });
  });

  it("clamps audioEndMs to the total enqueued duration even if played bytes overshoot it", () => {
    // Constructed directly (bypassing recordPlayedAudioBytes' own clamp) to prove the decision
    // function itself enforces the OpenAI-mandated invariant: audio_end_ms must never exceed the
    // real audio duration, regardless of how the state was assembled.
    const malformed: S2sTruncatePolicyState = {
      itemId: "item-3",
      enqueuedBytes: 1000, // 500 samples -> 20.833...ms -> floors to 20ms
      playedBytes: 5000, // would be 104ms if not clamped
      completed: false,
      truncatedItemId: null,
    };

    const decision = decideBargeInTruncate(malformed, RATE);
    expect(decision).toEqual({ shouldTruncate: true, itemId: "item-3", audioEndMs: 20 });
  });

  it("always returns an integer audioEndMs even when the ms computation is fractional", () => {
    const state = playingState("item-4", 100000, 33333);
    const decision = decideBargeInTruncate(state, RATE);
    expect(decision.shouldTruncate).toBe(true);
    if (decision.shouldTruncate) {
      expect(Number.isInteger(decision.audioEndMs)).toBe(true);
      expect(decision.audioEndMs).toBe(694);
    }
  });

  it("is idempotent: truncating the same item twice is a no-op the second time", () => {
    const state = playingState("item-5", 48000, 24000);

    const first = decideBargeInTruncate(state, RATE);
    expect(first).toEqual({ shouldTruncate: true, itemId: "item-5", audioEndMs: 500 });

    const issued = markTruncateIssued(state, "item-5");
    const second = decideBargeInTruncate(issued, RATE);
    expect(second).toEqual({ shouldTruncate: false });
  });

  it("stays safe to call repeatedly after a response.cancel has already fired", () => {
    const state = playingState("item-6", 48000, 10000);
    const issued = markTruncateIssued(decideBargeInTruncate(state, RATE).shouldTruncate ? state : state, "item-6");

    // Multiple barge-in signals firing after cancel must never throw and never re-issue.
    expect(decideBargeInTruncate(issued, RATE)).toEqual({ shouldTruncate: false });
    expect(decideBargeInTruncate(issued, RATE)).toEqual({ shouldTruncate: false });
  });

  it("does not let a previously truncated item block truncation of the next item", () => {
    let state = playingState("item-5", 48000, 24000);
    state = markTruncateIssued(state, "item-5");

    state = beginAssistantAudioItem(state, "item-7");
    state = recordEnqueuedAudioBytes(state, "item-7", 48000);
    state = recordPlayedAudioBytes(state, "item-7", 12000);

    const decision = decideBargeInTruncate(state, RATE);
    expect(decision).toEqual({ shouldTruncate: true, itemId: "item-7", audioEndMs: 250 });
  });

  it("defaults sampleRateHz to the standard 24kHz S2S output rate", () => {
    const state = playingState("item-1", 48000, 24000);
    const decision = decideBargeInTruncate(state);
    expect(decision).toEqual({ shouldTruncate: true, itemId: "item-1", audioEndMs: 500 });
  });
});
