import { randomInt } from "node:crypto";

import { PAIRING_CODE_LENGTH, PAIRING_CODE_TTL_MS } from "./constants.js";
import type { DeviceStore, IssuedToken } from "./device-store.js";

/**
 * Failed redeems tolerated before redeeming is locked out. An 8-digit code is ~10^8 wide,
 * so no budget is brute-forceable inside the 5-minute window.
 */
export const MAX_PAIRING_ATTEMPTS = 5;

/**
 * How long redeeming stays shut after the budget runs out. A lockout, not dropping pending
 * codes: with `/m/pair` on the internet (`issues/07`) that would be a denial of service against
 * the operator. The operator can clear it by issuing a code from the loopback-only admin surface.
 */
export const PAIRING_LOCKOUT_MS = 60 * 1000;

export interface PairingCode {
  code: string;
  expiresAt: number;
}

/** Short-lived, single-use codes that exchange for a device token (ADR-5). */
export class PairingService {
  private pending = new Map<string, number>();
  private failedAttempts = 0;
  private lockedUntilMs = 0;

  constructor(
    private readonly devices: DeviceStore,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Issues a code, and clears both the attempt budget and any lockout the operator is
   * about to work through. Reaching this method means being on the loopback admin
   * surface, so it is the one place where "the operator is here" is already proven.
   */
  create(): PairingCode {
    this.prune();
    this.failedAttempts = 0;
    this.lockedUntilMs = 0;

    const code = Array.from({ length: PAIRING_CODE_LENGTH }, () => randomInt(10)).join("");
    const expiresAt = this.now() + PAIRING_CODE_TTL_MS;
    this.pending.set(code, expiresAt);
    return { code, expiresAt };
  }

  /** Consumes `code` and returns the new device credential, or null if refused. */
  redeem(code: string, deviceName: string, refreshKey?: string): IssuedToken | null {
    this.prune();

    // Refused before the code is even looked at, so a lockout cannot be probed for
    // "was that one right?" and a correct code is not burned by an attacker who
    // happens to guess it while shut out.
    if (this.lockedUntil() > 0) return null;

    const expiresAt = this.pending.get(code);
    if (expiresAt === undefined || this.now() >= expiresAt) {
      this.registerFailure();
      return null;
    }

    this.pending.delete(code);
    return this.devices.issue(deviceName, refreshKey);
  }

  /** Timestamp redeeming reopens at, or 0 when it is open. */
  lockedUntil(): number {
    if (this.lockedUntilMs === 0) return 0;
    if (this.now() < this.lockedUntilMs) return this.lockedUntilMs;
    // Expired: the budget starts over, so a lockout costs the attacker the full window
    // again rather than leaving them one guess away from the next one.
    this.lockedUntilMs = 0;
    this.failedAttempts = 0;
    return 0;
  }

  pendingCount(): number {
    this.prune();
    return this.pending.size;
  }

  private registerFailure(): void {
    this.failedAttempts += 1;
    if (this.failedAttempts >= MAX_PAIRING_ATTEMPTS) {
      this.lockedUntilMs = this.now() + PAIRING_LOCKOUT_MS;
    }
  }

  private prune(): void {
    const at = this.now();
    for (const [code, expiresAt] of this.pending) {
      if (at >= expiresAt) this.pending.delete(code);
    }
  }
}
