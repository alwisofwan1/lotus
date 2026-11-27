import type { UserQuestion } from "./question.js";


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
  /** Show the screen excerpt as read-only; only a successful parse can supply actionable digits (ADR-8). */
  tail?: string;
  /** Use the full question when available because the compatibility prompt lacks option descriptions. */
  question?: UserQuestion[];
}
