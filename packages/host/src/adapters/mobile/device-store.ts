import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

import { atomicWriteSync } from "../../core/atomic-write.js";
import { DEVICE_HARD_TTL_MS, DEVICE_TOKEN_TTL_MS } from "./constants.js";

/**
 * What the operator's device receives once, at pairing or refresh time: [Device] plus the
 * bearer, so a new field cannot land in one and be missed in the other.
 */
export interface IssuedToken extends Device {
  token: string;
}

/** A verified caller. Carries no token material. */
export interface Device {
  deviceId: string;
  name: string;
  pairedAt: number;
  expiresAt: number;
  hardExpiresAt: number;
  /**
   * Whether this device can be woken by push. A boolean, never the token: this
   * summary is what the desktop's device list renders, and the registration token is
   * the capability to ring that phone.
   */
  push: boolean;
}

/** A device that can be woken, with the token needed to do it. */
export interface PushTarget {
  deviceId: string;
  pushToken: string;
}

interface DeviceRecord extends Omit<Device, "push"> {
  /** SHA-256 of the bearer. The bearer itself is never written to disk. */
  tokenHash: string;

  /**
   * FCM registration token, stored in the clear because sending requires it (the bearer is
   * only compared, so it is hashed). On the device record so revoking a device ends its
   * wake-ups in the same operation (ADR-8).
   */
  pushToken?: string;

  /**
   * The bearer this one replaced, kept until the phone proves it holds the new one: a refresh
   * reply lost in transit would otherwise force re-pairing. Lives no longer than
   * [previousExpiresAt]; dies when the new bearer is first presented.
   */
  previousTokenHash?: string;
  previousExpiresAt?: number;

  /** Base64 SPKI of the phone's hardware-bound key (`refresh-key.ts`), when it has one. */
  refreshKey?: string;
}

interface StoreData {
  devices: Record<string, DeviceRecord>;
}

/**
 * Device credentials for the mobile façade (ADR-5, ADR-8).
 * Two expiries: `expiresAt` is the 72h TTL a refresh can push forward, `hardExpiresAt` the
 * 30-day ceiling it cannot. Without it a stolen unlocked phone refreshes forever.
 */
export class DeviceStore {
  private data: StoreData = { devices: {} };

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  issue(name: string, refreshKey?: string): IssuedToken {
    const at = this.now();
    const token = randomBytes(32).toString("base64url");
    const record: DeviceRecord = {
      deviceId: `dev_${randomBytes(8).toString("hex")}`,
      name,
      pairedAt: at,
      expiresAt: at + DEVICE_TOKEN_TTL_MS,
      hardExpiresAt: at + DEVICE_HARD_TTL_MS,
      tokenHash: hash(token),
      ...(refreshKey === undefined ? {} : { refreshKey }),
    };
    this.data.devices[record.deviceId] = record;
    this.save();
    return { ...summary(record), token };
  }

  /** Returns the owning device, or null when the bearer is unknown or expired. */
  verify(token: string): Device | null {
    const found = this.findByToken(token);
    if (!found) return null;
    const { record, previous } = found;
    if (!this.live(record, previous)) return null;
    // The new bearer arrived: the one it replaced has nothing left to cover for.
    if (!previous && record.previousTokenHash !== undefined) {
      dropPrevious(record);
      this.save();
    }
    return summary(record);
  }

  /**
   * Rotates the bearer and pushes the TTL forward. Returns null past the hard ceiling, where
   * the operator must pair again. The old bearer lives on: see `previousTokenHash`.
   */
  refresh(token: string): IssuedToken | null {
    const found = this.findByToken(token);
    if (!found) return null;
    const { record, previous } = found;
    if (!this.live(record, previous)) return null;
    const at = this.now();

    // Refreshing with the previous bearer is the retry of a refresh whose reply was lost.
    // The bearer that reply carried was never seen by anyone, so it is simply replaced,
    // and the previous one keeps the expiry it already had rather than gaining a new one.
    if (!previous) {
      record.previousTokenHash = record.tokenHash;
      record.previousExpiresAt = record.expiresAt;
    }
    const next = randomBytes(32).toString("base64url");
    record.tokenHash = hash(next);
    record.expiresAt = at + DEVICE_TOKEN_TTL_MS;
    this.save();
    return { ...summary(record), token: next };
  }

  /** The device's registered refresh key, or undefined when it paired without one. */
  refreshKeyOf(deviceId: string): string | undefined {
    return this.data.devices[deviceId]?.refreshKey;
  }

  /**
   * A fresh bearer for a device that proved presence with its hardware key (signature
   * verified by the caller, `renewal.ts`). Unlike [refresh] it works past the TTL and ceiling
   * and moves both. A revoked device has no record, so it cannot return this way.
   */
  renewWithKey(deviceId: string): IssuedToken | null {
    const record = this.data.devices[deviceId];
    if (record?.refreshKey === undefined) return null;
    const at = this.now();
    const next = randomBytes(32).toString("base64url");
    record.tokenHash = hash(next);
    record.expiresAt = at + DEVICE_TOKEN_TTL_MS;
    record.hardExpiresAt = at + DEVICE_HARD_TTL_MS;
    dropPrevious(record);
    this.save();
    return { ...summary(record), token: next };
  }

  revoke(deviceId: string): void {
    if (this.data.devices[deviceId] === undefined) return;
    delete this.data.devices[deviceId];
    this.save();
  }

  /**
   * Records where to wake this device, replacing any previous token: FCM rotates tokens, and
   * two live ones would ring twice per event.
   */
  setPushToken(deviceId: string, pushToken: string): boolean {
    const record = this.data.devices[deviceId];
    if (record === undefined) return false;
    if (record.pushToken === pushToken) return true; // No write for a no-op refresh.
    record.pushToken = pushToken;
    this.save();
    return true;
  }

  /** Forgets how to wake a device — an operator opting out, or a token FCM rejected. */
  clearPushToken(deviceId: string): void {
    const record = this.data.devices[deviceId];
    if (record?.pushToken === undefined) return;
    delete record.pushToken;
    this.save();
  }

  /**
   * Every device that can currently be woken, filtered by the same expiry rules as [verify]:
   * waking a phone past its TTL or ceiling would reach a screen that can only re-pair.
   */
  withPushToken(): PushTarget[] {
    const at = this.now();
    return Object.values(this.data.devices)
      .filter((d) => d.pushToken !== undefined && at < d.expiresAt && at < d.hardExpiresAt)
      .map((d) => ({ deviceId: d.deviceId, pushToken: d.pushToken! }));
  }

  /** Active devices, newest pairing first. Never includes token material. */
  list(): Device[] {
    return Object.values(this.data.devices)
      .map(summary)
      .sort((a, b) => b.pairedAt - a.pairedAt);
  }

  /** Matches the current bearer, or the one a refresh replaced (`previous: true`). */
  private findByToken(token: string): { record: DeviceRecord; previous: boolean } | undefined {
    if (token.length === 0) return undefined;
    const wanted = hash(token);
    for (const record of Object.values(this.data.devices)) {
      if (constantTimeEquals(record.tokenHash, wanted)) return { record, previous: false };
      if (record.previousTokenHash !== undefined && constantTimeEquals(record.previousTokenHash, wanted)) {
        return { record, previous: true };
      }
    }
    return undefined;
  }

  /** The same TTL and ceiling for both bearers; the previous one also keeps its own expiry. */
  private live(record: DeviceRecord, previous: boolean): boolean {
    const at = this.now();
    if (at >= record.expiresAt || at >= record.hardExpiresAt) return false;
    return !previous || at < (record.previousExpiresAt ?? 0);
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoreData>;
      this.data = { devices: parsed.devices ?? {} };
    } catch {
      this.data = { devices: {} };
    }
  }

  private save(): void {
    atomicWriteSync(this.filePath, this.data);
  }
}

function dropPrevious(record: DeviceRecord): void {
  delete record.previousTokenHash;
  delete record.previousExpiresAt;
}

function summary(record: DeviceRecord): Device {
  return {
    deviceId: record.deviceId,
    name: record.name,
    pairedAt: record.pairedAt,
    expiresAt: record.expiresAt,
    hardExpiresAt: record.hardExpiresAt,
    push: record.pushToken !== undefined,
  };
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Compares equal-length hex digests without leaking position via timing. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
