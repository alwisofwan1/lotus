/**
 * The waitlist seam.
 *
 * One function to learn: `prepare`. Behind it sits the work-email rule, channel
 * tagging, endpoint construction and the navigate-vs-inline choice. The UI renders
 * whatever plan comes back and never learns any of it.
 *
 * Channel attribution is the free path chosen in issues/06 over Buttondown's
 * $9/mo analytics add-on: a hidden `tag` field per placement tells us where a
 * signup came from, which is the only measurement question that matters.
 */
import { validateWorkEmail } from "./validate";
import { createFormAdapter } from "./adapters/form";
import { BUTTONDOWN_USERNAME, KNOWN_NOT_OURS } from "./config";
import type { PrepareResult, SubmissionPlan, WaitlistAdapter } from "./types";

export type { PrepareResult, SubmissionPlan, SubmitMode, Rejection, WaitlistAdapter } from "./types";
export { validateWorkEmail, explain } from "./validate";
export { createFormAdapter } from "./adapters/form";
export { createIframeAdapter } from "./adapters/iframe";

/** Where on the site (or which channel) a signup came from. Kept as a closed set
 *  so a typo cannot silently produce an unattributable signup. */
export type Channel = "hero" | "footer" | "x" | "reddit" | "directory" | "discord";

export interface Waitlist {
  prepare(input: { email: string; channel: Channel }): PrepareResult;
}

/**
 * The plan for an *empty* form — what the page renders before anyone types.
 *
 * Separate from `prepare` on purpose: `prepare` validates a submission, this only
 * describes where the form points. Both real adapters ignore the email when
 * describing, but going through the adapter keeps the endpoint in exactly one place.
 */
export function describeForm(adapter: WaitlistAdapter, channel: Channel) {
  return adapter.describe({ email: "", tag: channel });
}

/**
 * Whether a placement can accept a submission at all, and where it points if so.
 *
 * This is the one thing a section needs to know, which is why it is one call. It
 * used to take three imports at every call site — `describeForm`, an adapter
 * factory, and the config constant — and that spread the decision of *which*
 * adapter across the pages instead of keeping it here.
 *
 * Closed is a real state, not an error: with no Buttondown account there is nowhere
 * safe to post, and a form that posts to a guessed handle posts to somebody else's
 * list. See `config.ts` for the account that actually exists at the handle this
 * repo used to guess.
 */
export type Placement =
  | { readonly open: true; readonly plan: SubmissionPlan }
  | { readonly open: false; readonly why: "unconfigured" | "not-ours" };

export function describePlacement(channel: Channel): Placement {
  const username = BUTTONDOWN_USERNAME;

  if (username === null || username.trim() === "") return { open: false, why: "unconfigured" };
  if (KNOWN_NOT_OURS.includes(username.trim().toLowerCase())) {
    return { open: false, why: "not-ours" };
  }

  // The iframe adapter stays unchosen: its contract lives behind the vendor's login
  // and cannot be verified without the account. The plain form needs no verification
  // to be safe, and the vendor's own docs require this shape. PLAN.md Fase 3 item 1.
  return { open: true, plan: describeForm(createFormAdapter(username), channel) };
}

export function createWaitlist(adapter: WaitlistAdapter): Waitlist {
  return {
    prepare({ email, channel }) {
      const validated = validateWorkEmail(email);
      if (!validated.ok) return { ok: false, rejection: validated.rejection };

      return {
        ok: true,
        plan: adapter.describe({ email: validated.email, tag: channel }),
      };
    },
  };
}
