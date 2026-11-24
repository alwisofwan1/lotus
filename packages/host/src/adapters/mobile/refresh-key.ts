import { createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * The hardware-bound refresh key a phone registers at pairing (PLAN.md §Kredensial,
 * addendum 2026-08-05: "kunci refresh yang terikat hardware").
 *
 * An EC P-256 keypair generated inside the phone's Keystore, usable only after the
 * operator proves presence. The host keeps the public half and, from it, can finally
 * *verify* the biometric gate it used to have to take on trust: a valid signature is a
 * proof of presence the bearer never was.
 */

/** What a renewal signs. Versioned and newline-separated so no field can bleed into another. */
export function renewalPayload(deviceId: string, nonce: string): string {
  return `lotus-renew/v1\n${deviceId}\n${nonce}`;
}

/**
 * Reads a base64 SubjectPublicKeyInfo, accepting only EC P-256 — what Android Keystore
 * produces for `KeyProperties.KEY_ALGORITHM_EC` with a `secp256r1` spec. Anything else is
 * refused rather than accepted on a weaker footing.
 */
export function parseRefreshKey(spkiBase64: string): KeyObject | null {
  try {
    const key = createPublicKey({ key: Buffer.from(spkiBase64, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec") return null;
    if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
    return key;
  } catch {
    return null;
  }
}

/** Verifies a DER-encoded ECDSA/SHA-256 signature — `SHA256withECDSA` on Android. */
export function verifyRenewal(spkiBase64: string, payload: string, signatureBase64: string): boolean {
  const key = parseRefreshKey(spkiBase64);
  if (key === null) return false;
  try {
    return verify("sha256", Buffer.from(payload, "utf8"), { key, dsaEncoding: "der" },
      Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}
