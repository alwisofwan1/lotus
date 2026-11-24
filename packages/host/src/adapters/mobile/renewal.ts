import { randomBytes } from "node:crypto";

import type { DeviceStore, IssuedToken } from "./device-store.js";
import { renewalPayload, verifyRenewal } from "./refresh-key.js";

/** How long a challenge waits for its signature: one biometric prompt, with room to fumble it. */
export const RENEWAL_CHALLENGE_TTL_MS = 2 * 60 * 1000;

interface Challenge {
  nonce: string;
  expiresAt: number;
}

/**
 * Brings a lapsed device back on a signature from its hardware-bound key.
 *
 * Two steps, so a signature can never be replayed: the host names a fresh nonce, the
 * phone signs it after the operator proves presence, and the nonce is spent whether the
 * signature checks out or not. One outstanding challenge per device, kept in memory —
 * the map is bounded by the paired devices that registered a key, not by callers.
 */
export class RenewalService {
  private readonly challenges = new Map<string, Challenge>();

  constructor(
    private readonly devices: Pick<DeviceStore, "refreshKeyOf" | "renewWithKey">,
    private readonly now: () => number = Date.now,
  ) {}

  /** A nonce to sign, or null for a device that is unknown or has no key. */
  challenge(deviceId: string): Challenge | null {
    if (this.devices.refreshKeyOf(deviceId) === undefined) return null;
    const issued = {
      nonce: randomBytes(32).toString("base64url"),
      expiresAt: this.now() + RENEWAL_CHALLENGE_TTL_MS,
    };
    this.challenges.set(deviceId, issued);
    return issued;
  }

  /** A new bearer when [signature] signs the outstanding nonce, otherwise null. */
  renew(deviceId: string, nonce: string, signature: string): IssuedToken | null {
    const pending = this.challenges.get(deviceId);
    if (pending === undefined || pending.nonce !== nonce) return null;
    this.challenges.delete(deviceId);
    if (this.now() >= pending.expiresAt) return null;

    const key = this.devices.refreshKeyOf(deviceId);
    if (key === undefined) return null; // Revoked between the two steps.
    if (!verifyRenewal(key, renewalPayload(deviceId, nonce), signature)) return null;
    return this.devices.renewWithKey(deviceId);
  }
}
