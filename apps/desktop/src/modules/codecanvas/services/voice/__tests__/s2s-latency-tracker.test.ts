import { describe, expect, it, vi } from "vitest";
import { createS2sLatencyTracker, type S2sLatencyEventInput } from "../s2s-latency-tracker";

describe("S2S latency tracker", () => {
  it("records sanitized per-turn milestones and derived durations", () => {
    const events: S2sLatencyEventInput[] = [];
    const tracker = createS2sLatencyTracker((event) => events.push(event));

    tracker.beginTurn(3, 100);
    tracker.markSpeechEnd(3, 200);
    tracker.markTranscriptFinal(3, 260);
    tracker.markToolStart(3, "private-call-id", 280);
    tracker.markToolEnd("private-call-id", 350);
    tracker.markFirstAudio(3, 420);

    expect(events).toEqual([
      { milestone: "speech-start", turn: 3 },
      { milestone: "speech-end", turn: 3 },
      { milestone: "transcript-final", turn: 3, elapsedFromSpeechEndMs: 60 },
      { milestone: "tool-start", turn: 3, elapsedFromSpeechEndMs: 80 },
      { milestone: "tool-end", turn: 3, elapsedFromSpeechEndMs: 150, durationMs: 70 },
      { milestone: "first-audio-delta", turn: 3, elapsedFromSpeechEndMs: 220 },
    ]);
    expect(JSON.stringify(events)).not.toContain("private-call-id");
  });

  it("emits transcript-final and first-audio at most once per turn", () => {
    const record = vi.fn();
    const tracker = createS2sLatencyTracker(record);

    tracker.beginTurn(1, 0);
    tracker.markSpeechEnd(1, 10);
    tracker.markTranscriptFinal(1, 20);
    tracker.markTranscriptFinal(1, 30);
    tracker.markFirstAudio(1, 40);
    tracker.markFirstAudio(1, 50);

    expect(record.mock.calls.map(([event]) => event.milestone)).toEqual([
      "speech-start",
      "speech-end",
      "transcript-final",
      "first-audio-delta",
    ]);
  });

  it("resets private timing state between sessions", () => {
    const record = vi.fn();
    const tracker = createS2sLatencyTracker(record);

    tracker.beginTurn(1, 10);
    tracker.markSpeechEnd(1, 20);
    tracker.markToolStart(1, "old", 30);
    tracker.reset();
    tracker.markToolEnd("old", 40);
    tracker.markFirstAudio(1, 50);

    expect(record).toHaveBeenCalledTimes(3);
  });
});
