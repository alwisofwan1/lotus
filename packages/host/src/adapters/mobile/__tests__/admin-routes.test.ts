import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DeviceStore } from "../device-store.js";
import { PairingService } from "../pairing.js";
import { buildAdminRouter } from "../admin-routes.js";
import { BUILD_ID } from "../../../core/build-id.js";
import { call } from "./support/call.js";

const SECRET = "a".repeat(64);

describe("admin HTTP routes", () => {
  let dir: string;
  let devices: DeviceStore;
  let pairing: PairingService;
  let audit: string[];
  let router: ReturnType<typeof buildAdminRouter>;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lotus-admin-"));
    now = Date.parse("2026-08-04T10:00:00Z");
    devices = new DeviceStore(join(dir, "devices.json"), () => now);
    pairing = new PairingService(devices, () => now);
    audit = [];
    router = buildAdminRouter({
      devices,
      pairing,
      secret: SECRET,
      host: { hostId: "mac", hostLabel: "MacBook", mode: "client" },
      mobileAddress: () => ({ host: "100.64.0.2", port: 8787 }),
      audit: (event, fields) => audit.push(`${event}:${JSON.stringify(fields ?? {})}`),
    });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // ─── Auth ──────────────────────────────────────────────────────────────────

  it("refuses every route without a bearer", async () => {
    for (const [method, url] of [
      ["POST", "/admin/pairing-code"],
      ["GET", "/admin/devices"],
      ["DELETE", "/admin/devices/dev-1"],
      ["GET", "/admin/health"],
    ] as const) {
      const res = await call(router, method, url);
      expect(res.status, `${method} ${url}`).toBe(401);
    }
  });

  it("refuses a wrong secret of the same length", async () => {
    const res = await call(router, "POST", "/admin/pairing-code", undefined, "b".repeat(64));
    expect(res.status).toBe(401);
  });

  // A shorter secret must not pass by being a prefix of the real one.
  it("refuses a secret that is a prefix of the real one", async () => {
    const res = await call(router, "POST", "/admin/pairing-code", undefined, "a".repeat(32));
    expect(res.status).toBe(401);
  });

  it("records rejected admin calls so a local probe leaves a trace", async () => {
    await call(router, "GET", "/admin/devices", undefined, "wrong");
    expect(audit.some((a) => a.startsWith("auth.rejected:"))).toBe(true);
  });

  // ─── Pairing code ──────────────────────────────────────────────────────────

  it("mints a pairing code the phone can actually redeem", async () => {
    const res = await call(router, "POST", "/admin/pairing-code", undefined, SECRET);

    expect(res.status).toBe(200);
    const body = res.json as { code: string; expiresAt: number };
    expect(body.code).toMatch(/^\d{8}$/);
    expect(body.expiresAt).toBeGreaterThan(now);

    // The point of the route: the code is live in the same PairingService the
    // mobile façade redeems against, not a lookalike.
    expect(pairing.redeem(body.code, "Phone")).not.toBeNull();
  });

  it("audits minting, because it creates a credential", async () => {
    await call(router, "POST", "/admin/pairing-code", undefined, SECRET);
    expect(audit.some((a) => a.startsWith("pairing.code_issued:"))).toBe(true);
  });

  // ─── Devices ───────────────────────────────────────────────────────────────

  it("lists paired devices", async () => {
    devices.issue("Phone A");
    devices.issue("Phone B");

    const res = await call(router, "GET", "/admin/devices", undefined, SECRET);

    expect(res.status).toBe(200);
    const body = res.json as { items: Array<{ name: string }> };
    expect(body.items.map((d) => d.name).sort()).toEqual(["Phone A", "Phone B"]);
  });

  // The desktop UI has no business receiving credentials, and this is the seam
  // where leaking one would be easiest to miss.
  it("never returns a token or its hash", async () => {
    devices.issue("Phone A");
    const res = await call(router, "GET", "/admin/devices", undefined, SECRET);

    const raw = JSON.stringify(res.json);
    expect(raw).not.toMatch(/token/i);
    expect(raw).not.toMatch(/[0-9a-f]{64}/);
  });

  it("revokes a device by id", async () => {
    const issued = devices.issue("Phone A");

    const res = await call(router, "DELETE", `/admin/devices/${issued.deviceId}`, undefined, SECRET);

    expect(res.status).toBe(200);
    expect(devices.list()).toHaveLength(0);
    expect(audit.some((a) => a.startsWith("device.revoked:"))).toBe(true);
  });

  // Revoke is the button someone presses when a phone is lost, so it must not
  // fail in a way that looks like the phone is still paired.
  it("answers 404 for an unknown device rather than pretending success", async () => {
    const res = await call(router, "DELETE", "/admin/devices/nope", undefined, SECRET);
    expect(res.status).toBe(404);
  });

  // ─── Health ────────────────────────────────────────────────────────────────

  // The settings UI needs to distinguish "façade running on the tailnet" from
  // "façade running on loopback", because the second cannot be reached by a phone.
  it("reports the address the mobile façade actually bound", async () => {
    const res = await call(router, "GET", "/admin/health", undefined, SECRET);

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      ok: true,
      hostId: "mac",
      mode: "client",
      mobile: { host: "100.64.0.2", port: 8787 },
    });
  });

  /// Which build is answering.
  ///
  /// The one thing no surface could say. `/health` carried a hardcoded `"0.1.0"` that never
  /// moved, and `hostCaps.features` only *implied* an age — a VPS ran a binary four days old
  /// for days, and the drift was found by comparing two hosts and remembering which feature
  /// landed when. Issue 20 of `plans/pocket-without-laptop`.
  it("names the build that is answering", async () => {
    const res = await call(router, "GET", "/admin/health", undefined, SECRET);

    expect((res.json as { build: unknown }).build).toBe(BUILD_ID);
  });

  it("says `dev` when nothing was baked in, rather than guessing a version", async () => {
    // Run from source there is no build to name, and an invented number is what `"0.1.0"`
    // already was. `--define` is what replaces this at compile time.
    expect(BUILD_ID).toBe("dev");
  });

  it("says so when the mobile façade is not bound at all", async () => {
    router = buildAdminRouter({
      devices,
      pairing,
      secret: SECRET,
      host: { hostId: "mac", hostLabel: "MacBook", mode: "client" },
      mobileAddress: () => null,
      audit: () => {},
    });

    const res = await call(router, "GET", "/admin/health", undefined, SECRET);

    expect(res.status).toBe(200);
    expect((res.json as { mobile: unknown }).mobile).toBeNull();
  });
});
