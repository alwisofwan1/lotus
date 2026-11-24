/**
 * Iframe adapter — the preferred path, because the form is the site's only
 * conversion event and bouncing the visitor to a third-party page at the moment
 * of success throws away the chance to state the promise.
 *
 * It keeps our origin script-free: the JS runs inside Buttondown's frame, not on
 * our page. That is the distinction that made this preferable to the web-component
 * option, which *does* need a script on our origin.
 *
 * NOT YET VERIFIED (2026-08-23): the exact embed contract lives behind
 * buttondown.com/settings/embedding, which requires an account. If it turns out to
 * demand a script on our page, fall back to `createFormAdapter` — do not add JS.
 * Tracked in plans/lotus-web/PLAN.md Fase 3.
 */
import type { WaitlistAdapter } from "../types";

export function createIframeAdapter(username: string): WaitlistAdapter {
  return {
    mode: "inline",
    describe: ({ tag }) => ({
      mode: "inline",
      action: `https://buttondown.com/api/emails/embed-subscribe/${username}`,
      method: "post",
      hidden: [
        { name: "embed", value: "1" },
        { name: "tag", value: tag },
      ],
    }),
  };
}
