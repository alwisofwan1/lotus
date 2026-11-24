import { describe, expect, it } from "vitest";

import { answerUserQuestion, readUserQuestion } from "../questions.js";

/**
 * Captured from the real CLI on 2026-09-08 by driving `claude --print` with an approval
 * server that logged what `--permission-prompt-tool` was handed. Not invented: the field
 * names here are the reason this module can exist at all.
 */
const CAPTURED = {
  questions: [
    {
      question: "Tabs or spaces?",
      header: "Indentation",
      options: [
        { label: "Spaces", description: "Indent with spaces." },
        { label: "Tabs", description: "Indent with tab characters." },
      ],
      multiSelect: false,
    },
  ],
};

describe("reading what AskUserQuestion is asking", () => {
  it("takes the question and its options, in the runner's own words", () => {
    // The header comes along — it is the CLI's own short word for the question, and the only
    // label short enough to name one question among several.
    expect(readUserQuestion(CAPTURED)).toEqual({
      question: "Tabs or spaces?",
      header: "Indentation",
      options: [
        { label: "Spaces", description: "Indent with spaces." },
        { label: "Tabs", description: "Indent with tab characters." },
      ],
    });
  });

  it("keeps an option that carries no description", () => {
    const read = readUserQuestion({
      questions: [{ question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] }],
    });
    expect(read?.options).toEqual([{ label: "Yes" }, { label: "No" }]);
  });

  /**
   * The phone answers with **one printed digit** (ADR-8). Two questions need two answers, and
   * a digit cannot carry them — so this reports that it cannot be represented rather than
   * answering the first and leaving the agent to believe the rest were answered too.
   */
  it("refuses a question set it cannot answer with one digit", () => {
    const two = {
      questions: [
        { question: "A?", options: [{ label: "1" }] },
        { question: "B?", options: [{ label: "2" }] },
      ],
    };
    expect(readUserQuestion(two)).toBeUndefined();
  });

  it("refuses anything that is not a question with options", () => {
    expect(readUserQuestion({})).toBeUndefined();
    expect(readUserQuestion({ questions: [] })).toBeUndefined();
    expect(readUserQuestion({ questions: [{ question: "A?", options: [] }] })).toBeUndefined();
    expect(readUserQuestion({ questions: [{ options: [{ label: "x" }] }] })).toBeUndefined();
  });
});

describe("answering it", () => {
  /**
   * The answer rides back as the tool's **own input, rewritten** — proved against the real
   * CLI on 2026-09-08: the tool then returns `Your questions have been answered: … ` and the
   * agent carries on. Allowing the call without this makes it run and report *No answer
   * received*, which is the state a Pocket cell was in until now.
   */
  it("rewrites the tool's input to carry the chosen label", () => {
    expect(answerUserQuestion(CAPTURED, "Spaces")).toEqual({
      ...CAPTURED,
      answers: { "Tabs or spaces?": "Spaces" },
    });
  });

  it("leaves an input it cannot read untouched", () => {
    expect(answerUserQuestion({ nothing: true }, "Spaces")).toEqual({ nothing: true });
  });
});
