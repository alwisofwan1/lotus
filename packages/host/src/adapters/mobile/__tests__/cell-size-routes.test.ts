import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceStore } from "../device-store.js";
import { PairingService } from "../pairing.js";
import { buildMobileRouter } from "../http-routes.js";
import type { MobileRouterDeps } from "../http-routes.js";
import { hostFeatures } from "../host-features.js";
import { ApiError } from "../../../core/api-error.js";
import { call } from "./support/call.js";

/** `/m/cell/:paneId/size` — a façade over the desktop's lease (ADR-6 addendum 2026-10-05). */
describe("the phone's hold on a pane's size", () => {
  let dir: string;
  let api: MobileRouterDeps["api"];
  let router: ReturnType<typeof buildMobileRouter>;
  let token: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "lotus-size-"));
    const now = Date.parse("2026-10-05T10:00:00Z");
    const devices = new DeviceStore(join(dir, "devices.json"), () => now);
    const pairing = new PairingService(devices, () => now);
    api = {
      holdSessionSize: vi.fn().mockResolvedValue({ held: true, token: 7 }),
      releaseSessionSize: vi.fn().mockResolvedValue(undefined),
    } as unknown as MobileRouterDeps["api"];
    router = buildMobileRouter({
      api,
      devices,
      pairing,
      host: { hostId: "mac", hostLabel: "MacBook", mode: "client" },
      audit: () => {},
      fleetSnapshot: async () => [
        { paneId: "p-1", workspaceId: "ws", agentType: "claude", title: "Chase", status: "live", isAlive: true, sessionId: "sess-1" },
        { paneId: "p-dead", workspaceId: "ws", agentType: "claude", title: "Gone", status: "idle", isAlive: false },
      ],
    });
    const { code } = pairing.create();
    const paired = await call(router, "POST", "/m/pair", { pairingCode: code, deviceName: "Pixel" });
    token = (paired.json as { deviceToken: string }).deviceToken;
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("starts a hold on the pane's session and hands back the lease", async () => {
    const res = await call(router, "POST", "/m/cell/p-1/size", { cols: 54, rows: 30 }, token);

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ held: true, token: 7 });
    expect(api.holdSessionSize).toHaveBeenCalledWith("sess-1", { cols: 54, rows: 30 });
  });

  it("renews with the token it was given", async () => {
    await call(router, "POST", "/m/cell/p-1/size", { cols: 54, rows: 30, token: 7 }, token);

    expect(api.holdSessionSize).toHaveBeenCalledWith("sess-1", { cols: 54, rows: 30, token: 7 });
  });

  it("passes on a lost hold as an answer, not an error", async () => {
    vi.mocked(api.holdSessionSize).mockResolvedValueOnce({ held: false });

    const res = await call(router, "POST", "/m/cell/p-1/size", { cols: 54, rows: 30, token: 7 }, token);

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ held: false });
  });

  it.each([
    [{ cols: 0, rows: 30 }],
    [{ cols: 54.5, rows: 30 }],
    [{ cols: 54, rows: 9999 }],
    [{ cols: "54", rows: 30 }],
    [{ cols: 54, rows: 30, token: "7" }],
  ])("refuses %j", async (body) => {
    expect((await call(router, "POST", "/m/cell/p-1/size", body, token)).status).toBe(400);
    expect(api.holdSessionSize).not.toHaveBeenCalled();
  });

  it("says a pane with no session has no terminal to size", async () => {
    expect((await call(router, "POST", "/m/cell/p-dead/size", { cols: 54, rows: 30 }, token)).status)
      .toBe(404);
  });

  it("forwards a desktop's refusal, such as one too old to have the route", async () => {
    vi.mocked(api.holdSessionSize).mockRejectedValueOnce(new ApiError(404, "Not Found"));

    expect((await call(router, "POST", "/m/cell/p-1/size", { cols: 54, rows: 30 }, token)).status)
      .toBe(404);
  });

  it("releases by token, and a release for a gone pane still succeeds", async () => {
    expect((await call(router, "POST", "/m/cell/p-1/size/release", { token: 7 }, token)).status).toBe(200);
    expect(api.releaseSessionSize).toHaveBeenCalledWith("sess-1", 7);

    expect((await call(router, "POST", "/m/cell/p-dead/size/release", { token: 7 }, token)).status).toBe(200);
    expect(api.releaseSessionSize).toHaveBeenCalledTimes(1);
  });

  it("refuses both without a bearer", async () => {
    expect((await call(router, "POST", "/m/cell/p-1/size", { cols: 54, rows: 30 }, undefined)).status).toBe(401);
    expect((await call(router, "POST", "/m/cell/p-1/size/release", { token: 7 }, undefined)).status).toBe(401);
  });

  it("is advertised by a desktop-backed host only", () => {
    expect(hostFeatures("client")).toContain("pty-size");
    expect(hostFeatures("standalone")).not.toContain("pty-size");
  });
});
