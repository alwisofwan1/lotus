/**
 * The waitlist seam's vocabulary.
 *
 * `mode` is the only thing that genuinely varies between adapters, and it varies
 * for a decided reason (issues/08): a plain HTML form keeps the page script-free
 * but navigates the visitor to Buttondown; an iframe keeps them here. Two real
 * adapters, so a real seam.
 */

export type SubmitMode = "navigate" | "inline";

export type Rejection =
  | { reason: "empty" }
  | { reason: "malformed" }
  | { reason: "free-provider"; provider: string };

/** What the UI needs in order to render a submission. No DOM types here — that is
 *  the whole point of the seam. */
export interface SubmissionPlan {
  readonly mode: SubmitMode;
  readonly action: string;
  readonly method: "post";
  /** Rendered as hidden inputs, in order. Includes the channel tag. */
  readonly hidden: readonly { readonly name: string; readonly value: string }[];
}

export type PrepareResult =
  | { readonly ok: true; readonly plan: SubmissionPlan }
  | { readonly ok: false; readonly rejection: Rejection };

export interface WaitlistAdapter {
  readonly mode: SubmitMode;
  /** Given a validated email and a channel tag, describe the submission. */
  describe(input: { email: string; tag: string }): SubmissionPlan;
}
