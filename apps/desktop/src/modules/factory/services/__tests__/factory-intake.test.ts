import { describe, expect, it } from "vitest";
import type { FactoryIntake, FactoryQuestion } from "@/lib/tauri/graph-run";
import { answerDecision, answeredRounds, answersProblem, approveDecision, initialAnswers } from "@/modules/factory/services/factory-intake";
import { intakeWaitsFor, openIntakeTurn } from "@/modules/factory/services/factory-run";

const Q: FactoryQuestion[] = [
  { question: "Which text?", choices: ["Current", "Original"], recommended: "Current", why: "The ticket says current" },
  { question: "Toast?", choices: ["Yes", "No"], recommended: "Maybe", why: "" },
];

describe("factory intake form", () => {
  it("starts on the recommended choice, and on none when it is not a choice", () => {
    expect(initialAnswers(Q)).toEqual([{ choice: "Current", note: "" }, { choice: null, note: "" }]);
  });

  it("needs a choice or a note for each question, and only real choices", () => {
    expect(answersProblem(Q, initialAnswers(Q))).toBe("Question 2: choose an answer or write one.");
    expect(answersProblem(Q, [{ choice: "Current", note: "" }, { choice: null, note: "  my own " }])).toBeNull();
    expect(answersProblem(Q, [{ choice: "Other", note: "" }, { choice: "No", note: "" }])).toBe("Question 1: that is not one of its choices.");
    expect(answersProblem(Q, [{ choice: "Current", note: "x".repeat(4001) }, { choice: "No", note: "" }])).toMatch(/longer than 4000/);
  });

  it("sends the shape graph_run_decide reads: choice left out when none, notes trimmed", () => {
    expect(answerDecision([{ choice: "Current", note: "" }, { choice: null, note: " mine " }])).toEqual({
      kind: "answer",
      answers: [{ choice: "Current", note: "" }, { note: "mine" }],
    });
  });

  it("approves as written unless the edit changed the spec", () => {
    expect(approveDecision("# S", null)).toEqual({ kind: "approve" });
    expect(approveDecision("# S", "# S\n")).toEqual({ kind: "approve" });
    expect(approveDecision("# S", "# S2")).toEqual({ kind: "approve", spec: "# S2" });
  });

  it("knows what the intake waits for, like Intake::state in Rust", () => {
    const asked: FactoryIntake = { turns: [{ kind: "asked", questions: Q, at: 1 }], approved: false };
    expect(intakeWaitsFor(asked)).toBe("answers");
    expect(openIntakeTurn(asked)?.kind).toBe("asked");
    const spec: FactoryIntake = {
      turns: [{ kind: "asked", questions: Q, answers: [{ choice: "Current", note: "" }, { note: "x" }], at: 1 }, { kind: "spec", markdown: "# S", live: false, at: 2 }],
      approved: false,
    };
    expect(intakeWaitsFor(spec)).toBe("approval");
    expect(answeredRounds(spec)).toBe(1);
    expect(intakeWaitsFor({ ...spec, approved: true })).toBeNull();
    const sentBack: FactoryIntake = { ...spec, turns: [...spec.turns.slice(0, 1), { kind: "spec", markdown: "# S", sentBack: "more", live: false, at: 2 }] };
    expect(intakeWaitsFor(sentBack)).toBeNull();
    expect(openIntakeTurn(sentBack)).toBeNull();
    expect(intakeWaitsFor(null)).toBeNull();
  });
});
