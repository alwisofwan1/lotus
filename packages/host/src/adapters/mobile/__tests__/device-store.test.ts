import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEVICE_HARD_TTL_MS, DEVICE_TOKEN_TTL_MS } from "../constants.js";
import { DeviceStore } from "../device-store.js";
import { testRefreshKey } from "./support/refresh-keys.js";

const HOUR = 60 * 60 * 1000;

// Read from the constant rather than hardcoded, so a future TTL change (like this
// one, 12h -> 72h) does not leave the tests asserting a number nobody chose anymore.
const TTL = DEVICE_TOKEN_TTL_MS;
const HARD_TTL = DEVICE_HARD_TTL_MS;

describe("DeviceStore", () => {
  let dir: string;
  let path: string;
  let now: number;
  const clock = (): number => now;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lotus-devices-"));
    path = join(dir, "devices.json");
    now = Date.parse("2026-08-02T10:00:00Z");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const store = (): DeviceStore => new DeviceStore(path, clock);

  describe("issue", () => {
    it("returns a token only once and never persists it verbatim", () => {
      const s = store();
      const issued = s.issue("iPhone");

      expect(issued.token.length).toBeGreaterThanOrEqual(32);
      expect(readFileSync(path, "utf8")).not.toContain(issued.token);
    });

    it("gives each device a distinct id and token", () => {
      const s = store();
      const a = s.issue("iPhone");
      const b = s.issue("iPad");

      expect(a.deviceId).not.toBe(b.deviceId);
      expect(a.token).not.toBe(b.token);
    });

    it("expires the token at the configured TTL and caps the device at 30 days", () => {
      const issued = store().issue("iPhone");

      expect(issued.expiresAt).toBe(now + TTL);
      expect(issued.pairedAt).toBe(now);
      expect(issued.hardExpiresAt).toBe(now + HARD_TTL);
    });
  });

  describe("verify", () => {
    it("accepts a fresh token and reports the owning device", () => {
      const s = store();
      const issued = s.issue("iPhone");

      expect(s.verify(issued.token)).toMatchObject({
        deviceId: issued.deviceId,
        name: "iPhone",
      });
    });

    it("rejects an unknown token", () => {
      expect(store().verify("not-a-real-token")).toBeNull();
    });

    it("rejects a token past its TTL", () => {
      const s = store();
      const issued = s.issue("iPhone");

      now += TTL + 1;

      expect(s.verify(issued.token)).toBeNull();
    });

    it("survives a reload so a host restart does not unpair every device", () => {
      const issued = store().issue("iPhone");

      expect(store().verify(issued.token)).toMatchObject({ name: "iPhone" });
    });
  });

  describe("refresh", () => {
    it("issues a new token and invalidates the previous one once the new one is used", () => {
      const s = store();
      const first = s.issue("iPhone");

      now += HOUR;
      const next = s.refresh(first.token);

      expect(next?.token).toBeDefined();
      expect(next?.token).not.toBe(first.token);
      expect(s.verify(next!.token)).toMatchObject({ deviceId: first.deviceId });
      expect(s.verify(first.token)).toBeNull();
    });

    describe("when the refresh reply never reaches the phone", () => {
      it("keeps the previous token working, so the phone is not locked out", () => {
        const s = store();
        const first = s.issue("iPhone");

        now += HOUR;
        s.refresh(first.token); // Reply lost: the phone still holds `first`.

        expect(s.verify(first.token)).toMatchObject({ deviceId: first.deviceId });
      });

      it("lets the phone refresh again with the previous token", () => {
        const s = store();
        const first = s.issue("iPhone");

        now += HOUR;
        const lost = s.refresh(first.token)!;
        now += HOUR;
        const retried = s.refresh(first.token);

        expect(retried?.expiresAt).toBe(now + TTL);
        // The lost bearer was never seen by anyone; the retry replaces it.
        expect(s.verify(lost.token)).toBeNull();
        expect(s.verify(retried!.token)).toMatchObject({ deviceId: first.deviceId });
        expect(s.verify(first.token)).toBeNull();
      });

      it("does not let the previous token outlive the expiry it already had", () => {
        const s = store();
        const first = s.issue("iPhone");

        now += HOUR;
        s.refresh(first.token);
        now = first.expiresAt;

        expect(s.verify(first.token)).toBeNull();
        expect(s.refresh(first.token)).toBeNull();
      });

      it("is cut off by a revoke like the current token", () => {
        const s = store();
        const first = s.issue("iPhone");
        s.refresh(first.token);

        s.revoke(first.deviceId);

        expect(s.verify(first.token)).toBeNull();
      });

      it("survives a host restart", () => {
        const first = store().issue("iPhone");
        now += HOUR;
        store().refresh(first.token);

        expect(store().verify(first.token)).toMatchObject({ deviceId: first.deviceId });
      });
    });

    it("extends the TTL from the moment of refresh", () => {
      const s = store();
      const first = s.issue("iPhone");

      now += 6 * HOUR;

      expect(s.refresh(first.token)?.expiresAt).toBe(now + TTL);
    });

    it("refuses past the 30-day ceiling even while the TTL is still valid", () => {
      const s = store();
      const first = s.issue("iPhone");

      // Keep the token alive by refreshing just inside every TTL window, right up
      // against the boundary rather than comfortably inside it.
      const step = TTL - HOUR;
      let token = first.token;
      for (let elapsed = 0; elapsed < HARD_TTL; elapsed += step) {
        now += step;
        const next = s.refresh(token);
        if (next === null) break;
        token = next.token;
      }

      now += HOUR;
      expect(s.refresh(token)).toBeNull();
      expect(s.verify(token)).toBeNull();
    });

    it("rejects an unknown token", () => {
      expect(store().refresh("nope")).toBeNull();
    });
  });

  describe("refresh key", () => {
    it("is kept with the device it was paired with, and only that one", () => {
      const s = store();
      const key = testRefreshKey().publicKey;
      const keyed = s.issue("Pixel", key);
      const keyless = s.issue("Old phone");

      expect(store().refreshKeyOf(keyed.deviceId)).toBe(key);
      expect(s.refreshKeyOf(keyless.deviceId)).toBeUndefined();
      expect(readFileSync(path, "utf8")).not.toContain(keyed.token);
    });

    it("renews a keyed device past its TTL and ceiling, moving both", () => {
      const s = store();
      const first = s.issue("Pixel", testRefreshKey().publicKey);
      now += HARD_TTL + HOUR;

      const renewed = s.renewWithKey(first.deviceId);

      expect(renewed?.expiresAt).toBe(now + TTL);
      expect(renewed?.hardExpiresAt).toBe(now + HARD_TTL);
      expect(s.verify(renewed!.token)).toMatchObject({ deviceId: first.deviceId });
      expect(s.verify(first.token)).toBeNull();
    });

    it("will not renew a device that has no key, or no record", () => {
      const s = store();
      const keyless = s.issue("Old phone");

      expect(s.renewWithKey(keyless.deviceId)).toBeNull();
      expect(s.renewWithKey("dev_gone")).toBeNull();
    });
  });

  describe("revoke", () => {
    it("kills the token immediately", () => {
      const s = store();
      const issued = s.issue("iPhone");

      s.revoke(issued.deviceId);

      expect(s.verify(issued.token)).toBeNull();
    });

    it("leaves other devices untouched", () => {
      const s = store();
      const phone = s.issue("iPhone");
      const tablet = s.issue("iPad");

      s.revoke(phone.deviceId);

      expect(s.verify(tablet.token)).toMatchObject({ name: "iPad" });
    });

    it("is a no-op for an unknown device", () => {
      expect(() => store().revoke("device-that-never-existed")).not.toThrow();
    });
  });

  describe("list", () => {
    it("reports devices without exposing any token material", () => {
      const s = store();
      const issued = s.issue("iPhone");

      const listed = s.list();

      expect(listed).toEqual([
        {
          deviceId: issued.deviceId,
          name: "iPhone",
          pairedAt: issued.pairedAt,
          expiresAt: issued.expiresAt,
          hardExpiresAt: issued.hardExpiresAt,
          // A boolean, never the registration token: this summary is what the
          // desktop's device list renders, and that token is the capability to ring
          // the phone. It answers "can this device be woken", which is what an
          // operator wondering why their phone stayed silent needs.
          push: false,
        },
      ]);
      expect(JSON.stringify(listed)).not.toContain(issued.token);
    });

    it("omits revoked devices", () => {
      const s = store();
      const issued = s.issue("iPhone");
      s.revoke(issued.deviceId);

      expect(s.list()).toEqual([]);
    });
  });

  it("starts empty when the file is missing or corrupt", () => {
    expect(store().list()).toEqual([]);

    const s = new DeviceStore(join(dir, "corrupt.json"), clock);
    expect(s.list()).toEqual([]);
  });
});
