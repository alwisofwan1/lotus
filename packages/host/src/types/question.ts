/** Use a shared question type so wire contracts and runner readers can preserve the original choices independently. */
export interface UserQuestionOption {
  label: string;
  description?: string;
  /** Omit the digit when the host cannot send the corresponding terminal keystroke. */
  key?: string;
}

export interface UserQuestion {
  question: string;
  /** The short word the CLI's own tab bar uses for it — `Resolusi`, `Scope`. */
  header?: string;
  /** Whether more than one option may be chosen. Absent means one. */
  multiSelect?: boolean;
  options: UserQuestionOption[];
}
