import type { PartBase } from "./conversation.js";
import type { UserQuestion } from "./question.js";

/**
 * The two parts that are **waiting on the operator**, as opposed to recording what already
 * happened.
 *
 * Split out of `conversation.ts` when that file crossed the 300-line rule, and the seam is the
 * one the product already draws: every other part is an account of a step the agent took, where
 * these two stop the turn until a person answers. They are also the two the phone draws as a
 * card rather than as a line.
 *
 * **And they are two, not one.** A permission asks leave to act and takes a yes or a no; a
 * question asks the operator to *choose*, and every option carries words of its own. Collapsing
 * them is how a five-option design question reached a phone under an amber `PERMISSION` banner
 * above **Allow once** and **Deny**. `bb` keeps them apart for the same reason
 * (`user-question-form-state.ts`).
 */
export interface PermissionOption {
  /** The digit printed beside the option — never its position (ADR-8). */
  key: string;
  label: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | "other";
}

export interface PermissionPart extends PartBase {
  type: "permission";
  requestId: string;
  toolCallId?: string;
  title: string;
  options: PermissionOption[];
  outcome?: { selected: string } | { cancelled: true };
  /**
   * `question` when the agent is asking the operator to **choose**, rather than asking leave
   * to act — `AskUserQuestion` on Claude. Absent means a permission, which is what every
   * client built before this field will read it as, and the safe way round: a question drawn
   * as a permission is mislabelled, where a permission drawn as a question is a destructive
   * action wearing a softer word.
   */
  ask?: "question";
}

/**
 * A question the agent is putting to the operator, with its options as the agent wrote them.
 *
 * **Its own part, not a permission with a flag.** A permission asks leave to act and takes a yes
 * or a no; this asks the operator to *choose*, and every option carries words of its own — which
 * is why it has `questions` rather than a `title` and a list of labels. `bb` draws the same line
 * (`user-question-form-state.ts`), and it is the line that stops a five-option design question
 * arriving under an amber `PERMISSION` banner above **Allow once** / **Deny**.
 *
 * `answered` is what the operator chose, once they have. Absent means it is still open — the same
 * shape `PermissionPart.outcome` uses, and for the same reason: a client must be able to tell a
 * question being held from one already settled without asking anything else.
 */
export interface QuestionPart extends PartBase {
  type: "question";
  /** What `decide` answers, on a cell whose bridge is holding the call open. Absent on a TUI cell. */
  requestId?: string;
  /** The tool call this question belongs to, when the runner reported one. */
  toolCallId?: string;
  questions: UserQuestion[];
  /** Chosen labels, per question, keyed by the question's own text. */
  answered?: Record<string, string[]>;
  /**
   * The operator refused it — Esc at a terminal, or a cell closed while it waited.
   *
   * Its own field rather than an empty `answered`, because "chose nothing" and "was never
   * going to choose" are different things to draw. Neither field means it is still open, which
   * is the only state a client may draw a control for.
   */
  cancelled?: true;
}
