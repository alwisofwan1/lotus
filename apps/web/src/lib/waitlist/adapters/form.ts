/**
 * Plain HTML form adapter — the fallback path, and the one that needs no
 * verification to be safe.
 *
 * Buttondown's own docs require this shape and forbid `fetch`:
 *
 *   "The `embed-subscribe` endpoint must be the `action` of a standard HTML
 *    <form>. Do not send requests to it with JavaScript's `fetch` API: subscribers
 *    sometimes need to follow Buttondown's response to complete CAPTCHA
 *    verification or correct a validation error."
 *   — https://docs.buttondown.com/building-your-subscriber-base
 *
 * Consequence accepted: submitting navigates away to Buttondown. There is no
 * documented redirect-back parameter (checked 2026-08-23).
 */
import type { WaitlistAdapter } from "../types";

export function createFormAdapter(username: string): WaitlistAdapter {
  return {
    mode: "navigate",
    describe: ({ tag }) => ({
      mode: "navigate",
      action: `https://buttondown.com/api/emails/embed-subscribe/${username}`,
      method: "post",
      hidden: [
        { name: "embed", value: "1" },
        { name: "tag", value: tag },
      ],
    }),
  };
}
