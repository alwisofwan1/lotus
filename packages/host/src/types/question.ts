/**
 * A question the agent is putting to the operator — `AskUserQuestion` on Claude.
 *
 * Its own file, and its own type, because a question is **not** a permission. A permission asks
 * leave to act and takes a yes or a no; this asks the operator to *choose*, and every option
 * carries words of its own. `bb` draws the same line from the other direction — a question is an
 * interaction of its own there, never a permission wearing a flag
 * (`user-question-form-state.ts`).
 *
 * Read from the runner's own record of the call by `adapters/mobile/questions.ts`; the shape
 * lives here so both the wire types and the reader can name it without one importing the other.
 */
export interface UserQuestionOption {
  label: string;
  description?: string;
  /**
   * The digit that answers this option, when it can be answered at all.
   *
   * Present on a cell this host runs itself, where the bridge holds the call open and a digit
   * releases it. **Absent on a cell with a terminal**, where the answer is a keystroke into a
   * TUI that Lotus cannot yet compose — and an option drawn with a digit it cannot honour is a
   * button that does nothing.
   */
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
