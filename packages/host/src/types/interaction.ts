import type { PartBase } from "./conversation.js";
import type { UserQuestion } from "./question.js";

/** Model questions separately because their choices cannot be represented as permission allow/deny. */
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
  /** Default to permission handling so an unclassified approval cannot appear as an ordinary question. */
  ask?: "question";
}

/** Preserve each question's choices and settled state so clients can render the interaction without another request. */
export interface QuestionPart extends PartBase {
  type: "question";
  /** What `decide` answers, on a cell whose bridge is holding the call open. Absent on a TUI cell. */
  requestId?: string;
  /** The tool call this question belongs to, when the runner reported one. */
  toolCallId?: string;
  questions: UserQuestion[];
  /** Chosen labels, per question, keyed by the question's own text. */
  answered?: Record<string, string[]>;
  /** Track refusal separately so clients only show controls while the question is open. */
  cancelled?: true;
}
