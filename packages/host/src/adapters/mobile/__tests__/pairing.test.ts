import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DeviceStore } from "../device-store.js";
import { MAX_PAIRING_ATTEMPTS, PAIRING_LOCKOUT_MS, PairingService } from "../pairing.js";

describe("PairingService", () => {
  let dir: string;
  let now: number;
  let devices: DeviceStore;
  let pairing: PairingService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lotus-pairing-"));
    now = Date.parse("2026-08-02T10:00:00Z");
    devices = new DeviceStore(join(dir, "devices.json"), () => now);
    pairing = new PairingService(devices, () => now);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe("create", () => {
    it("returns an 8-digit code that expires in 5 minutes", () => {
      const created = pairing.create();

      expect(created.code).toMatch(/^\d{8}$/);
      expect(created.expiresAt).toBe(now + 5 * 60 * 1000);
    });

    it("returns a different code each time", () => {
      const codes = new Set(Array.from({ length: 20 }, () => pairing.create().code));

      expect(codes.size).toBeGreaterThan(1);
    });
  });

  describe("redeem", () => {
    it("exchanges a valid code for a device token", () => {
      const { code } = pairing.create();

      const issued = pairing.redeem(code, "iPhone");

      expect(issued?.token).toBeDefined();
      expect(devices.verify(issued!.token)).toMatchObject({ name: "iPhone" });
    });

    it("burns the code — a replayed code is refused", () => {
      const { code } = pairing.create();
      pairing.redeem(code, "iPhone");

      expect(pairing.redeem(code, "attacker")).toBeNull();
      expect(devices.list()).toHaveLength(1);
    });

    it("refuses an expired code", () => {
      const { code } = pairing.create();

      now += 5 * 60 * 1000 + 1;

      expect(pairing.redeem(code, "iPhone")).toBeNull();
      expect(devices.list()).toEqual([]);
    });

    it("refuses an unknown code", () => {
      pairing.create();

      expect(pairing.redeem("00000000", "iPhone")).toBeNull();
    });

    /**
     * An 8-digit code is ~10^8 wide, so an unbounded redeem endpoint is brute-forceable
     * inside the 5-minute window. The budget must therefore stop the guessing — but
     * from 2026-09-05 it must NOT do so by dropping the operator's pending codes.
     *
     * `issues/07` put this route on the internet with no Cloudflare Access in front of
     * it (verdict (b)), and a budget that destroys pending codes is a denial of service
     * anyone can trigger: five guesses and the operator can never pair. A lockout stops
     * the same guessing, costs the attacker the same, and leaves the legitimate code alive.
     */
    it("locks redeems out once the attempt budget is exhausted", () => {
      pairing.create();

      for (let i = 0; i < MAX_PAIRING_ATTEMPTS; i += 1) {
        expect(pairing.redeem("99999999", "attacker")).toBeNull();
      }

      expect(pairing.lockedUntil()).toBe(now + PAIRING_LOCKOUT_MS);
    });

    it("keeps the operator's pending code alive through a lockout", () => {
      const { code } = pairing.create();

      for (let i = 0; i < MAX_PAIRING_ATTEMPTS; i += 1) pairing.redeem("99999999", "attacker");
      expect(pairing.redeem(code, "iPhone")).toBeNull();

      now += PAIRING_LOCKOUT_MS;

      expect(pairing.redeem(code, "iPhone")?.token).toBeDefined();
    });

    it("refuses even a correct code while locked out, without burning it", () => {
      const { code } = pairing.create();
      for (let i = 0; i < MAX_PAIRING_ATTEMPTS; i += 1) pairing.redeem("99999999", "attacker");

      expect(pairing.redeem(code, "attacker")).toBeNull();
      expect(pairing.pendingCount()).toBe(1);
    });

    it("does not extend a lockout by guessing during one", () => {
      pairing.create();
      for (let i = 0; i < MAX_PAIRING_ATTEMPTS; i += 1) pairing.redeem("99999999", "attacker");
      const until = pairing.lockedUntil();

      now += 1000;
      for (let i = 0; i < 20; i += 1) pairing.redeem("88888888", "attacker");

      expect(pairing.lockedUntil()).toBe(until);
    });

    /**
     * The operator is on the loopback-only admin surface, so reaching `create` already
     * proves they are on the machine. Letting that clear the lockout turns an outsider's
     * denial of service into "press the button again".
     */
    it("lets the operator clear a lockout by issuing a fresh code", () => {
      for (let i = 0; i < MAX_PAIRING_ATTEMPTS; i += 1) pairing.redeem("99999999", "attacker");

      const { code } = pairing.create();

      expect(pairing.lockedUntil()).toBe(0);
      expect(pairing.redeem(code, "iPhone")?.token).toBeDefined();
    });

    it("forgets failed attempts once a fresh code is issued", () => {
      pairing.create();
      for (let i = 0; i < MAX_PAIRING_ATTEMPTS - 1; i += 1) {
        pairing.redeem("99999999", "attacker");
      }

      const { code } = pairing.create();

      expect(pairing.redeem(code, "iPhone")?.token).toBeDefined();
    });

    it("does not count a successful redeem against the budget", () => {
      for (let i = 0; i < MAX_PAIRING_ATTEMPTS + 2; i += 1) {
        const { code } = pairing.create();
        expect(pairing.redeem(code, `device-${i}`)?.token).toBeDefined();
      }

      expect(devices.list()).toHaveLength(MAX_PAIRING_ATTEMPTS + 2);
    });
  });

  describe("pending", () => {
    it("drops codes that have aged out", () => {
      pairing.create();
      expect(pairing.pendingCount()).toBe(1);

      now += 5 * 60 * 1000 + 1;

      expect(pairing.pendingCount()).toBe(0);
    });
  });
});
