import { describe, expect, it } from "vitest";
import { resolveSpokenResponsePolicy } from "../spoken-response-policy";

describe("resolveSpokenResponsePolicy", () => {
  it("keeps routine acknowledgements short without imposing the same word cap on evidence-bearing results", () => {
    const acknowledgement = resolveSpokenResponsePolicy({ kind: "acknowledgement" });
    const result = resolveSpokenResponsePolicy({ kind: "result" });

    expect(acknowledgement).toMatchObject({
      maxSentences: 1,
      maxWords: 14,
      includeEvidence: false,
    });
    expect(result.maxSentences).toBeGreaterThan(acknowledgement.maxSentences);
    expect(result.maxWords).toBeUndefined();
    expect(result.includeEvidence).toBe(true);
  });

  it("expands result depth from brief through normal to expressive", () => {
    const brief = resolveSpokenResponsePolicy({ kind: "result", verbosity: "brief" });
    const normal = resolveSpokenResponsePolicy({ kind: "result", verbosity: "normal" });
    const expressive = resolveSpokenResponsePolicy({ kind: "result", verbosity: "expressive" });

    expect([brief.maxSentences, normal.maxSentences, expressive.maxSentences]).toEqual([2, 3, 5]);
    expect(brief.includeEvidence).toBe(true);
    expect(normal.includeEvidence).toBe(true);
    expect(expressive.includeEvidence).toBe(true);
  });

  it("asks one clear clarification question at a time", () => {
    const clarification = resolveSpokenResponsePolicy({ kind: "clarification", verbosity: "expressive" });

    expect(clarification).toMatchObject({
      maxSentences: 1,
      maxQuestions: 1,
      includeEvidence: false,
    });
  });

  it("requires evidence and a next action in result synthesis", () => {
    const result = resolveSpokenResponsePolicy({ kind: "result" });

    expect(result).toMatchObject({
      includeEvidence: true,
      includeNextAction: true,
    });
  });
});
