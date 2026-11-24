/**
 * Where the waitlist actually posts — and why it is `null` rather than a guess.
 *
 * This file used to read `BUTTONDOWN_USERNAME = "lotus"` as a placeholder, on the
 * assumption that a wrong destination was harmless until Fase 3 filled it in. That
 * assumption was wrong in a way worth recording:
 *
 *   `https://buttondown.com/lotus` is a REAL newsletter belonging to a real person
 *   (title: "Lotus Rogers • Buttondown"). Checked in a browser on 2026-08-23.
 *
 * So the placeholder was not a dead end, it was a stranger's mailing list. Nothing
 * leaked, because the site's own CSP said `form-action 'self'` and blocked every
 * submission — accidental protection, discovered only because fixing the CSP turned
 * a dead form into a live one pointed at the wrong account. A guess about someone
 * else's namespace is not a placeholder; it is a defect waiting for a working
 * network path.
 *
 * `null` means the waiting list is closed: every placement renders the promise and
 * the field, and submits nowhere. Set this to the real account handle and every
 * placement opens at once. `KNOWN_NOT_OURS` keeps this specific mistake from being
 * made twice.
 */

/** The Buttondown account handle, or `null` while there is no account. */
export const BUTTONDOWN_USERNAME: string | null = null;

/**
 * Handles that belong to somebody else. Checked at the seam, so a typo cannot
 * quietly resume mailing strangers' addresses to a stranger's list.
 */
export const KNOWN_NOT_OURS: readonly string[] = ["lotus"];
