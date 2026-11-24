import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEVICE_TOKEN_TTL_MS } from "../constants.js";
import { DeviceStore } from "../device-store.js";
import { buildMobileRouter, type MobileRouterDeps } from "../http-routes.js";
import { PairingService } from "../pairing.js";
import { renewalPayload } from "../refresh-key.js";
import { RENEW_RATE_CAPACITY } from "../renew-routes.js";
import { call } from "./support/call.js";
import { testRefreshKey, type TestRefreshKey } from "./support/refresh-keys.js";

describe("pairing with a refresh key, and renewing with it", () => {
  let dir: string;
  let now: number;
  let devices: DeviceStore;
  let pairing: PairingService;
  let audit: string[];
  let router: ReturnType<typeof buildMobileRouter>;
  let key: TestRefreshKey;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lotus-renew-routes-"));
    now = Date.now();
    devices = new DeviceStore(join(dir, "devices.json"), () => now);
    pairing = new PairingService(devices, () => now);
    audit = [];
    key = testRefreshKey();
    router = buildMobileRouter({
      api: {} as MobileRouterDeps["api"],
      devices,
      pairing,
      host: { hostId: "vps", hostLabel: "vps", mode: "standalone" },
      audit: (event, fields) => audit.push(`${event}:${JSON.stringify(fields ?? {})}`),
      fleetSnapshot: async () => [],
    });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function pair(body: Record<string, unknown> = {}) {
    const { code } = pairing.create();
    return call(router, "POST", "/m/pair", { pairingCode: code, deviceName: "Pixel", ...body });
  }

  async function renew(deviceId: string, signer: TestRefreshKey = key) {
    const challenge = await call(router, "POST", "/m/devices/renew/challenge", { deviceId });
    const { nonce } = challenge.json as { nonce: string };
    return call(router, "POST", "/m/devices/renew", {
      deviceId, nonce, signature: signer.sign(renewalPayload(deviceId, nonce)),
    });
  }

  it("advertises renewal, so a phone knows whether to register a key", async () => {
    const res = await pair();
    const caps = (res.json as { hostCaps: { features: string[] } }).hostCaps;

    expect(caps.features).toContain("device-renew");
  });

  it("brings a lapsed device back on a signature, and the old bearer stays dead", async () => {
    const paired = (await pair({ refreshKey: key.publicKey })).json as { deviceId: string; deviceToken: string };
    now += DEVICE_TOKEN_TTL_MS + 1;

    const res = await renew(paired.deviceId);
    const renewed = res.json as { deviceToken: string; expiresAt: number; hardExpiresAt: number };

    expect(res.status).toBe(200);
    expect(renewed.expiresAt).toBe(now + DEVICE_TOKEN_TTL_MS);
    expect((await call(router, "GET", "/m/devices", undefined, renewed.deviceToken)).status).toBe(200);
    expect((await call(router, "GET", "/m/devices", undefined, paired.deviceToken)).status).toBe(401);
    expect(audit.some((l) => l.startsWith("device.renewed"))).toBe(true);
  });

  it("refuses a pairing whose key it cannot read, without spending the code", async () => {
    const { code } = pairing.create();

    const refused = await call(router, "POST", "/m/pair", { pairingCode: code, refreshKey: "nope" });
    const retried = await call(router, "POST", "/m/pair", { pairingCode: code });

    expect(refused.status).toBe(400);
    expect(retried.status).toBe(200);
  });

  it("answers one 401 for a keyless device, an unknown one, and a forged signature", async () => {
    const keyless = (await pair()).json as { deviceId: string };
    const keyed = (await pair({ refreshKey: key.publicKey })).json as { deviceId: string };

    const statuses = [
      (await call(router, "POST", "/m/devices/renew/challenge", { deviceId: keyless.deviceId })).status,
      (await call(router, "POST", "/m/devices/renew/challenge", { deviceId: "dev_nobody" })).status,
      (await renew(keyed.deviceId, testRefreshKey())).status,
    ];

    expect(statuses).toEqual([401, 401, 401]);
  });

  it("throttles one source before it can grind signatures", async () => {
    const source = { headers: { "cf-connecting-ip": "203.0.113.9" } };
    const statuses: number[] = [];
    for (let i = 0; i <= RENEW_RATE_CAPACITY; i++) {
      statuses.push((await call(router, "POST", "/m/devices/renew/challenge", { deviceId: "dev_x" }, undefined, source)).status);
    }

    expect(statuses.at(-1)).toBe(429);
  });
});
