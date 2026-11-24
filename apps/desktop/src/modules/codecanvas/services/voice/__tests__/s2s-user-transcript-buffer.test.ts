import { describe, expect, it } from "vitest";
import {
  appendFinalUserTranscript,
  authoritativeUserTranscript,
  consumeUserTranscript,
  initialS2sUserTranscriptBuffer,
  markAgentAudioStarted,
  markAgentReplied,
} from "../s2s-user-transcript-buffer";

describe("s2sUserTranscriptBuffer", () => {
  it("starts empty and fresh with no authoritative text", () => {
    const buffer = initialS2sUserTranscriptBuffer();
    expect(buffer).toEqual({ text: null, stale: false });
    expect(authoritativeUserTranscript(buffer)).toBeNull();
  });

  it("accumulates two consecutive final segments (split VAD) into one joined transcript", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "Ask Codex to review auth.ts");
    buffer = appendFinalUserTranscript(buffer, "and report the top five issues.");

    expect(authoritativeUserTranscript(buffer)).toBe(
      "Ask Codex to review auth.ts and report the top five issues.",
    );
  });

  it("replaces the buffer instead of appending once it is stale", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "Restart the failing agent.");
    buffer = markAgentReplied(buffer);

    buffer = appendFinalUserTranscript(buffer, "Actually, check the logs first.");

    expect(authoritativeUserTranscript(buffer)).toBe("Actually, check the logs first.");
  });

  it("replaces (not appends) when the buffer is stale and empty", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = markAgentReplied(buffer);
    buffer = appendFinalUserTranscript(buffer, "New request.");

    expect(authoritativeUserTranscript(buffer)).toBe("New request.");
  });

  it("consume resets the buffer to empty and fresh", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "Dispatch this task.");
    buffer = consumeUserTranscript(buffer);

    expect(buffer).toEqual({ text: null, stale: false });
    expect(authoritativeUserTranscript(buffer)).toBeNull();
  });

  it("a blank final segment is a no-op", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "Keep this text.");
    const beforeBlank = buffer;
    buffer = appendFinalUserTranscript(buffer, "   ");

    expect(buffer).toEqual(beforeBlank);
    expect(authoritativeUserTranscript(buffer)).toBe("Keep this text.");
  });

  it("authoritativeUserTranscript returns null when stale even if text is still present", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "Some earlier request.");
    buffer = markAgentReplied(buffer);

    expect(buffer.text).toBe("Some earlier request.");
    expect(buffer.stale).toBe(true);
    expect(authoritativeUserTranscript(buffer)).toBeNull();
  });

  it("markAgentReplied on an empty buffer just marks it stale", () => {
    const buffer = markAgentReplied(initialS2sUserTranscriptBuffer());
    expect(buffer).toEqual({ text: null, stale: true });
  });
});

// Slice 2 (merge accumulator) + Slice 3 (turn-boundary hardening) —
// plans/voice-dispatch-payload-integrity/PLAN.md
describe("s2sUserTranscriptBuffer — merge accumulator (Slice 2)", () => {
  it("idempotent: an exactly-equal segment repeat is a no-op", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "Turn on the lights.");
    const beforeRepeat = buffer;
    buffer = appendFinalUserTranscript(buffer, "Turn on the lights.");

    expect(buffer).toEqual(beforeRepeat);
    expect(authoritativeUserTranscript(buffer)).toBe("Turn on the lights.");
  });

  it("replace-by-item: a segment carrying an itemId replaces that item's earlier text instead of appending", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "Turn on the li", { itemId: "item-1" });
    buffer = appendFinalUserTranscript(buffer, "Turn on the lights.", { itemId: "item-1" });

    expect(authoritativeUserTranscript(buffer)).toBe("Turn on the lights.");
  });

  it("replace-by-item keeps distinct items as separate segments", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "Ask Codex to review auth.ts", { itemId: "item-1" });
    buffer = appendFinalUserTranscript(buffer, "and report the top five issues.", { itemId: "item-2" });
    buffer = appendFinalUserTranscript(buffer, "and report the top five issues, ranked.", { itemId: "item-2" });

    expect(authoritativeUserTranscript(buffer)).toBe(
      "Ask Codex to review auth.ts and report the top five issues, ranked.",
    );
  });

  it("overlap collapse: a cumulative snapshot that extends the accumulated text replaces it instead of concatenating", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "Sekarang");
    buffer = appendFinalUserTranscript(buffer, "Sekarang suruh Nova");

    expect(authoritativeUserTranscript(buffer)).toBe("Sekarang suruh Nova");
  });

  it("overlap collapse: a stale/shorter resend of the accumulated text is dropped, keeping the longer one", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "Sekarang suruh Nova untuk jelaskan project.");
    buffer = appendFinalUserTranscript(buffer, "Sekarang suruh Nova");

    expect(authoritativeUserTranscript(buffer)).toBe("Sekarang suruh Nova untuk jelaskan project.");
  });

  it("collapses the real six-snapshot reproduction into one merged segment (PLAN.md §2.1) — raw .text invariant", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "Oke, thank you.");
    buffer = appendFinalUserTranscript(buffer, "Oke, thank you. Sekarang");
    buffer = appendFinalUserTranscript(buffer, "Oke, thank you. Sekarang suruh Nova untuk");
    buffer = appendFinalUserTranscript(buffer, "Oke, thank you. Sekarang suruh Nova untuk jelaskan project.");
    buffer = appendFinalUserTranscript(
      buffer,
      "Oke, thank you. Sekarang suruh Nova untuk jelaskan project ini singkat saja.",
    );
    buffer = appendFinalUserTranscript(
      buffer,
      "Oke, thank you. Sekarang suruh Nova untuk jelaskan project ini singkat saja.",
    );

    // Overlap collapse is provably quadratic-duplication-free: the raw merged text is exactly the
    // single clean sentence, not the six-fold repeated blob from the incident screenshot.
    expect(buffer.text).toBe(
      "Oke, thank you. Sekarang suruh Nova untuk jelaskan project ini singkat saja.",
    );
  });

  it("drops the leading pleasantry sentence from the six-snapshot reproduction's authoritative transcript", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "Oke, thank you.");
    buffer = appendFinalUserTranscript(buffer, "Oke, thank you. Sekarang");
    buffer = appendFinalUserTranscript(buffer, "Oke, thank you. Sekarang suruh Nova untuk");
    buffer = appendFinalUserTranscript(buffer, "Oke, thank you. Sekarang suruh Nova untuk jelaskan project.");
    buffer = appendFinalUserTranscript(
      buffer,
      "Oke, thank you. Sekarang suruh Nova untuk jelaskan project ini singkat saja.",
    );
    buffer = appendFinalUserTranscript(
      buffer,
      "Oke, thank you. Sekarang suruh Nova untuk jelaskan project ini singkat saja.",
    );

    // Overlap collapse fuses all six snapshots into one segment, so the pleasantry drop must operate
    // at sentence granularity *inside* that merged text, not only across segment boundaries — this is
    // exactly the shape of the reported incident payload.
    expect(authoritativeUserTranscript(buffer)).toBe(
      "Sekarang suruh Nova untuk jelaskan project ini singkat saja.",
    );
  });

  it("preserves the legitimate split-VAD case: two genuinely different consecutive segments still join", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "Ask Codex to review auth.ts");
    buffer = appendFinalUserTranscript(buffer, "and report the top five issues.");

    expect(authoritativeUserTranscript(buffer)).toBe(
      "Ask Codex to review auth.ts and report the top five issues.",
    );
  });

  it("caps: evicts the oldest segment once maxSegments is exceeded and exposes truncated", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "Alpha.", { maxSegments: 3 });
    buffer = appendFinalUserTranscript(buffer, "Beta.", { maxSegments: 3 });
    buffer = appendFinalUserTranscript(buffer, "Gamma.", { maxSegments: 3 });
    expect(buffer.truncated).toBeFalsy();

    buffer = appendFinalUserTranscript(buffer, "Delta.", { maxSegments: 3 });

    expect(buffer.truncated).toBe(true);
    expect(authoritativeUserTranscript(buffer)).toBe("Beta. Gamma. Delta.");
  });

  it("caps: evicts the oldest segment(s) once maxChars is exceeded and exposes truncated", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "First distinct sentence here.", { maxChars: 40 });
    expect(buffer.truncated).toBeFalsy();

    buffer = appendFinalUserTranscript(buffer, "Second distinct sentence follows.", { maxChars: 40 });

    expect(buffer.truncated).toBe(true);
    expect(authoritativeUserTranscript(buffer)).toBe("Second distinct sentence follows.");
    expect(buffer.text!.length).toBeLessThanOrEqual(40);
  });

  it("caps never truncate silently when nothing was evicted", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "Short.", { maxSegments: 40, maxChars: 4000 });

    expect(buffer.truncated).toBeFalsy();
  });
});

describe("s2sUserTranscriptBuffer — turn-boundary hardening (Slice 3)", () => {
  it("time-based turn expiry: a segment arriving after TURN_GAP_MS starts a new turn regardless of reply state", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "Restart the failing agent.", { now: 1_000, turnGapMs: 5_000 });
    buffer = appendFinalUserTranscript(buffer, "Actually, check the logs first.", {
      now: 1_000 + 5_000 + 1,
      turnGapMs: 5_000,
    });

    expect(authoritativeUserTranscript(buffer)).toBe("Actually, check the logs first.");
  });

  it("time-based turn expiry does not fire for segments arriving within the gap", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "Ask Codex to review auth.ts", { now: 1_000, turnGapMs: 5_000 });
    buffer = appendFinalUserTranscript(buffer, "and report the top five issues.", {
      now: 1_000 + 4_000,
      turnGapMs: 5_000,
    });

    expect(authoritativeUserTranscript(buffer)).toBe(
      "Ask Codex to review auth.ts and report the top five issues.",
    );
  });

  it("barge-in boundary: once the agent has produced audio for the turn, the next user segment starts a new turn", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "Restart the failing agent.");

    buffer = markAgentAudioStarted(buffer);
    // Marking audio-started does not itself invalidate the transcript — only a *completed* reply
    // (markAgentReplied) does that immediately. The barge-in boundary is a transition on the *next*
    // segment, which is exactly the case eager VAD produces (no completed-reply event).
    expect(authoritativeUserTranscript(buffer)).toBe("Restart the failing agent.");

    buffer = appendFinalUserTranscript(buffer, "Actually, check the logs first.");

    expect(authoritativeUserTranscript(buffer)).toBe("Actually, check the logs first.");
  });

  it("social-prefix drop: a leading pure pleasantry is dropped once a later segment carries actionable content", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "Oke, thank you.");
    buffer = appendFinalUserTranscript(buffer, "Tolong jelaskan project ini.");

    expect(authoritativeUserTranscript(buffer)).toBe("Tolong jelaskan project ini.");
  });

  it("social-prefix drop is conservative: a turn that is only pleasantries keeps its text", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "Oke, thank you.");
    buffer = appendFinalUserTranscript(buffer, "Terima kasih.");

    expect(authoritativeUserTranscript(buffer)).toBe("Oke, thank you. Terima kasih.");
  });

  it("a pleasantry embedded mid-sentence as part of a real request is never stripped", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "Bilang thank you ke Nova.");

    expect(authoritativeUserTranscript(buffer)).toBe("Bilang thank you ke Nova.");
  });

  it("social-prefix drop only trims the front: a trailing pleasantry after the request stays", () => {
    let buffer = initialS2sUserTranscriptBuffer();
    buffer = appendFinalUserTranscript(buffer, "Tolong jelaskan project ini.");
    buffer = appendFinalUserTranscript(buffer, "Makasih.");

    expect(authoritativeUserTranscript(buffer)).toBe("Tolong jelaskan project ini. Makasih.");
  });
});
