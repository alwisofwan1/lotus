import { isRecord } from "./structured/bridges/acp/parts.js";
import type { UserQuestion, UserQuestionOption } from "../../types/question.js";

export type { UserQuestion, UserQuestionOption };

/**
 * `AskUserQuestion` — the one gated tool that is not asking permission: allow/deny discards
 * the question. The answer rides back as the tool's input via `updatedInput.answers`, as `bb` does.
 */
/** What this tool call asks, or `undefined` if not one choice. Fails closed to allow/deny. */
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
 * The single question this bridge can answer with one printed digit (ADR-8). `undefined` for
 * two or more: answering the first alone would imply the rest were answered. To render all of
 * them use [`readUserQuestions`].
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
 * The tool's input with the operator's choice written into it, keyed by the question's text
 * (how the CLI reads it back). An unreadable input is returned untouched, never rewritten.
 */
export function answerUserQuestion(input: unknown, label: string): Record<string, unknown> {
  const read = readUserQuestion(input);
  if (read === undefined || !isRecord(input)) {
    return isRecord(input) ? { ...input } : {};
  }
  return { ...input, answers: { [read.question]: label } };
}
