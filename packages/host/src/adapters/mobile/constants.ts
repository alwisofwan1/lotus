// Values dictated by the mobile façade's own policy (ADR-8, ADR-10). Kept here
// rather than in `core/` so `core/` stays transport-agnostic.

/**
 * Bearer lifetime. A refresh pushes this forward; the hard ceiling below wins.
 *
 * Was 12 hours until `plans/lotus-pocket` measured what that actually cost: the
 * client can only refresh proactively while the app is open, so 12 hours meant
 * re-pairing after any absence longer than that — including an ordinary weekend
 * away from the laptop (Friday evening to Monday morning is ~60 hours). Re-pairing
 * needs the desktop and an 8-digit code that dies in 5 minutes
 * (`PAIRING_CODE_TTL_MS`), which is exactly the kind of "must reach the machine
 * while away from it" cost ADR-8 already rejected for manual revocation.
 *
 * 72 hours covers that weekend with room either side. The cost, named rather than
 * hidden: nothing on this host verifies the client's biometric gate — it never sees
 * more than a bearer — so a stolen unlocked phone can carry this token for the
 * full 72 hours rather than 12. That is judged acceptable only because the token
 * is reachable exclusively over the operator's own tailnet.
 */
export const DEVICE_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

/** Ceiling from pairing that no refresh can extend — forces a re-pair. */
export const DEVICE_HARD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Pairing codes are short-lived and single-use, so a shoulder-surfed code dies fast. */
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

/** Digits in a pairing code — short enough to read off a QR fallback by hand. */
export const PAIRING_CODE_LENGTH = 8;
