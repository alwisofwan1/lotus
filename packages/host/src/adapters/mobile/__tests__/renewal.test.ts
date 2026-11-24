import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEVICE_HARD_TTL_MS, DEVICE_TOKEN_TTL_MS } from "../constants.js";
import { DeviceStore } from "../device-store.js";
import { renewalPayload } from "../refresh-key.js";
import { RENEWAL_CHALLENGE_TTL_MS, RenewalService } from "../renewal.js";
import { testRefreshKey, type TestRefreshKey } from "./support/refresh-keys.js";

const DAY = 24 * 60 * 60 * 1000;

describe("RenewalService", () => {
  let dir: string;
  let now: number;
  let devices: DeviceStore;
  let renewal: RenewalService;
  let key: TestRefreshKey;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lotus-renewal-"));
    now = Date.parse("2026-10-03T10:00:00Z");
    devices = new DeviceStore(join(dir, "devices.json"), () => now);
    renewal = new RenewalService(devices, () => now);
    key = testRefreshKey();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const signed = (deviceId: string) => {
    const { nonce } = renewal.challenge(deviceId)!;
    return { nonce, signature: key.sign(renewalPayload(deviceId, nonce)) };
  };

  it("brings back a device whose token lapsed, with a fresh TTL and ceiling", () => {
    const paired = devices.issue("Pixel", key.publicKey);
    now += DEVICE_TOKEN_TTL_MS + DAY;
    expect(devices.verify(paired.token)).toBeNull();

    const { nonce, signature } = signed(paired.deviceId);
    const renewed = renewal.renew(paired.deviceId, nonce, signature);

    expect(renewed?.expiresAt).toBe(now + DEVICE_TOKEN_TTL_MS);
    expect(renewed?.hardExpiresAt).toBe(now + DEVICE_HARD_TTL_MS);
    expect(devices.verify(renewed!.token)).toMatchObject({ deviceId: paired.deviceId });
    expect(devices.verify(paired.token)).toBeNull();
  });

  it("works past the 30-day ceiling, because the ceiling counts from the last proof", () => {
    const paired = devices.issue("Pixel", key.publicKey);
    now += DEVICE_HARD_TTL_MS + DAY;

    const { nonce, signature } = signed(paired.deviceId);

    expect(renewal.renew(paired.deviceId, nonce, signature)).not.toBeNull();
  });

  it("issues no challenge for a device that paired without a key, or never paired", () => {
    const keyless = devices.issue("Old phone");

    expect(renewal.challenge(keyless.deviceId)).toBeNull();
    expect(renewal.challenge("dev_unknown")).toBeNull();
  });

  it("refuses a signature from another key", () => {
    const paired = devices.issue("Pixel", key.publicKey);
    const { nonce } = renewal.challenge(paired.deviceId)!;
    const forged = testRefreshKey().sign(renewalPayload(paired.deviceId, nonce));

    expect(renewal.renew(paired.deviceId, nonce, forged)).toBeNull();
  });

  it("spends the nonce on any attempt, so a signature cannot be replayed", () => {
    const paired = devices.issue("Pixel", key.publicKey);
    const { nonce, signature } = signed(paired.deviceId);

    expect(renewal.renew(paired.deviceId, nonce, "AAAA")).toBeNull();
    expect(renewal.renew(paired.deviceId, nonce, signature)).toBeNull();
  });

  it("refuses a nonce it did not issue last, or one that went stale", () => {
    const paired = devices.issue("Pixel", key.publicKey);
    const first = signed(paired.deviceId);
    const second = signed(paired.deviceId);

    expect(renewal.renew(paired.deviceId, first.nonce, first.signature)).toBeNull();
    now += RENEWAL_CHALLENGE_TTL_MS;
    expect(renewal.renew(paired.deviceId, second.nonce, second.signature)).toBeNull();
  });

  it("cannot bring back a revoked device", () => {
    const paired = devices.issue("Pixel", key.publicKey);
    const { nonce, signature } = signed(paired.deviceId);

    devices.revoke(paired.deviceId);

    expect(renewal.renew(paired.deviceId, nonce, signature)).toBeNull();
  });
});
