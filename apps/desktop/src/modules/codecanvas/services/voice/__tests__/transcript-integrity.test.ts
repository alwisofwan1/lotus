import { describe, expect, it } from "vitest";
import {
  scoreTranscriptIntegrity,
  TRANSCRIPT_INTEGRITY_LENGTH_RATIO_THRESHOLD,
  TRANSCRIPT_INTEGRITY_NGRAM_RATIO_THRESHOLD,
  TRANSCRIPT_INTEGRITY_PREFIX_RATIO_THRESHOLD,
} from "../transcript-integrity";

const CORRUPTED_ACCUMULATOR_SAMPLE =
  "Oke, thank you. Oke, thank you. Sekarang Oke, thank you. Sekarang suruh Nova untuk Oke, thank you. " +
  "Sekarang suruh Nova untuk jelaskan project. Oke, thank you. Sekarang suruh Nova untuk jelaskan project ini singkat saja. " +
  "Oke, thank you. Sekarang suruh Nova untuk jelaskan project ini singkat saja.";

describe("scoreTranscriptIntegrity", () => {
  it("flags the real observed accumulator-duplication defect as degraded repetition", () => {
    const verdict = scoreTranscriptIntegrity({
      transcript: CORRUPTED_ACCUMULATOR_SAMPLE,
      objective: "Jelaskan project ini secara singkat",
    });

    expect(verdict.quality).toBe("degraded");
    expect(verdict.reasons).toContain("repetition");
    expect(verdict.metrics.repeatedNGramRatio).toBeGreaterThanOrEqual(
      TRANSCRIPT_INTEGRITY_NGRAM_RATIO_THRESHOLD,
    );
    expect(verdict.metrics.repeatedPrefixRatio).toBeGreaterThanOrEqual(
      TRANSCRIPT_INTEGRITY_PREFIX_RATIO_THRESHOLD,
    );
  });

  it("scores a clean, complete Indonesian sentence as clean", () => {
    const verdict = scoreTranscriptIntegrity({
      transcript: "Sekarang suruh Nova untuk jelaskan project ini secara singkat.",
    });

    expect(verdict.quality).toBe("clean");
    expect(verdict.reasons).toEqual([]);
  });

  it("scores a clean English sentence as clean", () => {
    const verdict = scoreTranscriptIntegrity({
      transcript: "Review auth.ts and report any security risks you find.",
    });

    expect(verdict.quality).toBe("clean");
    expect(verdict.reasons).toEqual([]);
  });

  it("is robust for empty input", () => {
    const verdict = scoreTranscriptIntegrity({ transcript: "" });

    expect(verdict.quality).toBe("clean");
    expect(verdict.metrics).toEqual({
      repeatedNGramRatio: 0,
      repeatedPrefixRatio: 0,
      lengthRatio: 0,
    });
  });

  it("is robust for a single word", () => {
    const verdict = scoreTranscriptIntegrity({ transcript: "Nova" });

    expect(verdict.quality).toBe("clean");
    expect(verdict.reasons).toEqual([]);
  });

  it("is robust for CJK text with no whitespace word boundaries", () => {
    const verdict = scoreTranscriptIntegrity({
      transcript: "今すぐノヴァにプロジェクトの説明をさせてください",
    });

    expect(verdict.quality).toBe("clean");
    expect(verdict.reasons).toEqual([]);
  });

  it("does not flag legitimate parallel-structure repetition (same verb, different objects)", () => {
    const verdict = scoreTranscriptIntegrity({
      transcript: "hapus file A, hapus file B, hapus file C",
    });

    expect(verdict.quality).toBe("clean");
    expect(verdict.reasons).toEqual([]);
  });

  it("does not flag the same legitimate repetition written as separate sentences", () => {
    const verdict = scoreTranscriptIntegrity({
      transcript: "Hapus file A. Hapus file B. Hapus file C.",
    });

    expect(verdict.quality).toBe("clean");
    expect(verdict.reasons).toEqual([]);
  });

  it("flags a bloated verbatim block riding behind a short, correctly-grounded objective", () => {
    const uniqueWords = Array.from({ length: 60 }, (_, index) => `kata${index}`).join(" ");
    const verdict = scoreTranscriptIntegrity({
      transcript: `Latar belakang panjang tidak relevan: ${uniqueWords}.`,
      objective: "Perbaiki bug login.",
    });

    expect(verdict.quality).toBe("degraded");
    expect(verdict.reasons).toContain("disproportionate");
    expect(verdict.metrics.lengthRatio).toBeGreaterThanOrEqual(
      TRANSCRIPT_INTEGRITY_LENGTH_RATIO_THRESHOLD,
    );
  });

  it("does not apply the length check when no objective is supplied", () => {
    const uniqueWords = Array.from({ length: 60 }, (_, index) => `kata${index}`).join(" ");
    const verdict = scoreTranscriptIntegrity({ transcript: uniqueWords });

    expect(verdict.metrics.lengthRatio).toBe(0);
    expect(verdict.reasons).not.toContain("disproportionate");
  });
});
