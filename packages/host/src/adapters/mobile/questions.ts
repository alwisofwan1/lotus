import { isRecord } from "./structured/bridges/acp/parts.js";
import type { UserQuestion, UserQuestionOption } from "../../types/question.js";

export type { UserQuestion, UserQuestionOption };

/**
 * `AskUserQuestion` — the one gated tool that is not asking for permission at all.
 *
 * It is how Claude puts a real question to the operator: *which of these do you want?* Every
 * other tool arriving at `--permission-prompt-tool` wants a yes or a no, and answering this
 * one with a yes is how a Pocket cell came to show `AskUserQuestion` above two buttons
 * reading **Allow once** and **Deny** — the question itself, and every option it offered,
 * thrown away before the operator saw them.
 *
 * Worse than losing the words: allowing it does not answer it. Probed against the real CLI on
 * 2026-09-08 — the tool runs, finds no interface to ask through, and returns *"No answer
 * received — question left unanswered."* So the agent is told nobody replied, whatever the
 * operator tapped.
 *
 * **The answer rides back as the tool's own input, rewritten.** `--permission-prompt-tool`
 * may return an `updatedInput`, and the CLI honours it: the same probe added an `answers` map
 * and the tool returned *"Your questions have been answered: 'Tabs or spaces?'='Spaces'"*, with
 * the agent carrying on from it. That is the whole mechanism, and it is the one `bb` uses
 * through the SDK's `canUseTool` (`interactions.ts` → `buildClaudeUserQuestionOutput`).
 */
/**
 * What this tool call is asking, or `undefined` when it cannot be put to the operator as one
 * choice.
 *
 * **Fails closed, like every other reading on this path.** `undefined` sends the call back to
 * the ordinary allow/deny card — which is wrong in a visible, recoverable way, where a
 * half-read question would be wrong invisibly.
 */
export function readUserQuestions(input: unknown): UserQuestion[] | undefined {
  if (!isRecord(input)) return undefined;
  const questions = input["questions"];
  if (!Array.isArray(questions) || questions.length === 0) return undefined;

  const read: UserQuestion[] = [];
  for (const raw of questions) {
    const one = readOne(raw);
    if (one === undefined) return undefined;
    read.push(one);
  }
  return read;
}

/**
 * The single question this bridge can answer with one printed digit.
 *
 * `undefined` for a set of two or more: the phone answers with a digit (ADR-8), and replying to
 * the first alone would leave the agent believing the rest were answered as well. A caller that
 * only wants to **render** the questions wants [`readUserQuestions`], which keeps them all.
 */
export function readUserQuestion(input: unknown): UserQuestion | undefined {
  const all = readUserQuestions(input);
  return all?.length === 1 ? all[0] : undefined;
}

function readOne(raw: unknown): UserQuestion | undefined {
  if (!isRecord(raw)) return undefined;
  const question = raw["question"];
  if (typeof question !== "string" || question.trim() === "") return undefined;
  const rawOptions = raw["options"];
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) return undefined;

  const options: UserQuestionOption[] = [];
  for (const option of rawOptions) {
    if (!isRecord(option)) return undefined;
    const label = option["label"];
    if (typeof label !== "string" || label === "") return undefined;
    const description = option["description"];
    options.push(
      typeof description === "string" && description !== "" ? { label, description } : { label },
    );
  }
  const header = raw["header"];
  const multiSelect = raw["multiSelect"];
  return {
    question,
    ...(typeof header === "string" && header !== "" ? { header } : {}),
    ...(multiSelect === true ? { multiSelect: true } : {}),
    options,
  };
}

/**
 * The tool's input with the operator's choice written into it.
 *
 * Keyed by the question's own text, which is what the CLI reads it back by. An input this
 * module could not read is returned untouched: the caller has already fallen back to a plain
 * approval by then, and rewriting an input we did not understand is how a tool comes to run
 * against arguments nobody chose.
 */
export function answerUserQuestion(input: unknown, label: string): Record<string, unknown> {
  const read = readUserQuestion(input);
  if (read === undefined || !isRecord(input)) {
    return isRecord(input) ? { ...input } : {};
  }
  return { ...input, answers: { [read.question]: label } };
}
