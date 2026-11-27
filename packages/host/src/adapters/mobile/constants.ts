// Values dictated by the mobile façade's own policy (ADR-8, ADR-10). Kept here
// rather than in `core/` so `core/` stays transport-agnostic.

/**
 * Bearer lifetime; a refresh pushes it forward, the hard ceiling below wins. 72h so a
 * weekend away does not force re-pairing (ADR-8). The host never verifies the biometric gate,
 * so a stolen unlocked phone carries it the full 72h: acceptable only over the operator's tailnet.
 */
export const DEVICE_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

/** Ceiling from pairing that no refresh can extend — forces a re-pair. */
export const DEVICE_HARD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Pairing codes are short-lived and single-use, so a shoulder-surfed code dies fast. */
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

/** Digits in a pairing code — short enough to read off a QR fallback by hand. */
export const PAIRING_CODE_LENGTH = 8;
