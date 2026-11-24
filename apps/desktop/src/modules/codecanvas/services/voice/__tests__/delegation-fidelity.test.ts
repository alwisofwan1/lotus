import { describe, expect, it } from "vitest";
import { evaluateDelegationFidelity } from "../delegation-fidelity";
import { DELEGATION_FIDELITY_FIXTURES } from "./fixtures/delegation-fidelity-fixtures";

describe("evaluateDelegationFidelity", () => {
  it("reports which explicit requirements a compressed worker payload lost", () => {
    const fixture = DELEGATION_FIDELITY_FIXTURES.find(({ id }) => id === "mixed-voice-audit");
    if (!fixture) throw new Error("mixed baseline fixture is missing");
    const report = evaluateDelegationFidelity(fixture);

    expect(report.invalid).toEqual([]);
    expect(report.covered).toEqual(["instructions-file", "executor-file", "five-findings"]);
    expect(report.missing).toEqual(["analysis-only", "file-line", "priority-range"]);
    expect(report.score).toBe(0.5);
    expect(report.complete).toBe(false);
  });

  it("does not treat a numeric substring as an exact source requirement", () => {
    const report = evaluateDelegationFidelity({
      transcript: "Temukan 15 akar masalah.",
      deliveredText: "Find 5 root causes.",
      requiredFacts: [
        { id: "five-findings", label: "five findings", allOf: [["5"]] },
      ],
    });

    expect(report.invalid).toEqual(["five-findings"]);
    expect(report.covered).toEqual([]);
    expect(report.complete).toBe(false);
  });

  it("rejects duplicate fact ids so checkpoint metrics stay unambiguous", () => {
    expect(() =>
      evaluateDelegationFidelity({
        transcript: "Audit voice.ts and report file:line evidence.",
        deliveredText: "Audit voice.ts and report file:line evidence.",
        requiredFacts: [
          { id: "evidence", label: "voice file", allOf: [["voice.ts"]] },
          { id: "evidence", label: "file line evidence", allOf: [["file:line"]] },
        ],
      }),
    ).toThrow(/duplicate delegation fidelity fact id: evidence/i);
  });

  it("keeps Indonesian, English, and mixed-language baseline scores reproducible", () => {
    expect(DELEGATION_FIDELITY_FIXTURES.map(({ language }) => language).sort()).toEqual([
      "en",
      "id",
      "mixed",
    ]);

    for (const fixture of DELEGATION_FIDELITY_FIXTURES) {
      const report = evaluateDelegationFidelity(fixture);
      expect(report.invalid, fixture.id).toEqual([]);
      expect(report.missing, fixture.id).toEqual(fixture.expectedMissing);
      expect(report.score, fixture.id).toBe(fixture.expectedScore);
    }
  });
});
