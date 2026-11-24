import type { UserQuestion } from "./question.js";

/**
 * What a cell is asking the operator, and the answers it will take.
 *
 * Split out of `fleet.ts` when that file crossed the 300-line rule, and the seam is a real
 * one: everything here is about **one cell's open question**, where what stays behind
 * describes the fleet — who is running, where, and in what state. The two are read by
 * different routes and change for different reasons.
 */

export interface PromptOption {
  /** Digit to write, exactly as printed. Never derived from the position. */
  key: string;
  /** The option's own words. Clients must render these verbatim, not paraphrase. */
  label: string;
  selected: boolean;
}

export interface PermissionPrompt {
  question: string;
  options: PromptOption[];
  /**
   * `question` when the agent is asking the operator to choose rather than for leave to act.
   * Absent means a permission — the reading every client built before this field already has,
   * and the safe one (see `PermissionPart.ask`).
   */
  ask?: "question";
}

export interface PermissionResponse {
  paneId: string;
  /** False when this host cannot tell whether a cell is waiting at all. */
  hostSupports?: boolean;
  /**
   * The hook's verdict. `true` with a null `prompt` means "waiting, but the
   * options could not be read" — render a pointer to the terminal, not "nothing".
   */
  awaiting: boolean;
  prompt: PermissionPrompt | null;
  /**
   * The prompt as one spoken sentence, for hands-free use. Absent whenever
   * `prompt` is. Speak it with device TTS: reading a known string aloud is easy,
   * so the BYOK meter never has to light up for this.
   */
  readback?: string;
  /**
   * What the terminal drew, when `awaiting` is true and the options could **not** be named.
   *
   * Present exactly where `prompt` is null and the cell is waiting — the case a client used to
   * render as one sentence and a button. It is for **reading**, never for answering: the digits
   * still come from a successful parse alone (ADR-8), so this can put words on screen but never
   * a button. Absent for a host too old to send it, which keeps rendering the sentence.
   */
  tail?: string;
  /**
   * The question this cell is holding, whole — every option with the sentence the agent wrote
   * under it, and the digit that answers it.
   *
   * Present instead of, not as well as, a permission: `prompt` is filled in beside it so a
   * client built before this field still draws buttons, but a client that has it should draw
   * from here. `{key,label}` has nowhere to keep an option's own words, and dropping them is
   * how a headless cell came to show "Spaces" with nothing to say what choosing it means.
   */
  question?: UserQuestion[];
}
