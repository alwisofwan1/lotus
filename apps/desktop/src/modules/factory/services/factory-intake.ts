import type { FactoryAnswer, FactoryDecision, FactoryIntake, FactoryQuestion } from "@/lib/tauri/graph-run";

/**
 * The intake form's rules (FI2), pure so they are tested without a pane. The engine checks the same
 * rules again (`check_answers` in the Rust crate); these only keep the Send button honest.
 */

/** Same limit as `NOTE_CHARS` in the Rust crate. */
export const INTAKE_NOTE_CHARS = 4000;

/** One answer as the form holds it: the recommended choice is picked to start with. */
export interface AnswerDraft {
  choice: string | null;
  note: string;
}

export function initialAnswers(questions: readonly FactoryQuestion[]): AnswerDraft[] {
  return questions.map((q) => ({ choice: q.choices.includes(q.recommended) ? q.recommended : null, note: "" }));
}

/** Why the answers cannot be sent yet; null when they can. */
export function answersProblem(questions: readonly FactoryQuestion[], drafts: readonly AnswerDraft[]): string | null {
  for (const [i, q] of questions.entries()) {
    const d = drafts[i];
    const n = i + 1;
    if (!d || (d.choice === null && d.note.trim() === "")) return `Question ${n}: choose an answer or write one.`;
    if (d.choice !== null && !q.choices.includes(d.choice)) return `Question ${n}: that is not one of its choices.`;
    if (d.note.length > INTAKE_NOTE_CHARS) return `Question ${n}: the note is longer than ${INTAKE_NOTE_CHARS} characters.`;
  }
  return null;
}

export function answerDecision(drafts: readonly AnswerDraft[]): FactoryDecision {
  const answers: FactoryAnswer[] = drafts.map((d) => ({ ...(d.choice !== null ? { choice: d.choice } : {}), note: d.note.trim() }));
  return { kind: "answer", answers };
}

/** Approve as written, or with the user's edit when it differs. */
export function approveDecision(written: string, edited: string | null): FactoryDecision {
  return edited !== null && edited.trim() !== written.trim() ? { kind: "approve", spec: edited } : { kind: "approve" };
}

/** Rounds of questions already answered: shown so the user sees how far the intake went. */
export function answeredRounds(intake: FactoryIntake | null): number {
  return (intake?.turns ?? []).filter((t) => t.kind === "asked" && t.answers !== undefined).length;
}
