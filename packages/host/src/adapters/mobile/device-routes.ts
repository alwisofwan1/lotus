import type { IncomingMessage, ServerResponse } from "node:http";

import type { AuditEvent, Fields } from "../../core/logger.js";
import type { Router } from "../../server/router.js";
import type { Device, DeviceStore } from "./device-store.js";
import { bearerOf, body_, send, str } from "./http-util.js";

/** Generous next to a real FCM registration token (~200 chars), and still a bound. */
export const MAX_PUSH_TOKEN_LENGTH = 4096;

export interface DeviceRouteDeps {
  devices: DeviceStore;
  audit: (event: AuditEvent, fields?: Fields) => void;
  /** The bearer check every route here shares, supplied by the main router. */
  guarded: (
    handler: (ctx: {
      req: IncomingMessage;
      res: ServerResponse;
      params: Record<string, string>;
      device: Device;
    }) => Promise<void>,
  ) => (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;
}

/**
 * `/m/devices/*` — the credential's own lifecycle: list, refresh, revoke, and where to wake
 * this phone. Split from `http-routes.ts` (300-line limit): this acts on the device record.
 */
export function addDeviceRoutes(router: Router, deps: DeviceRouteDeps): void {
  const { guarded } = deps;

  router.add("GET", "/m/devices", guarded(async ({ res }) => {
    send(res, 200, { items: deps.devices.list() });
  }));

  router.add("POST", "/m/devices/refresh", guarded(async ({ req, res, device }) => {
    const bearer = bearerOf(req);
    const next = bearer === undefined ? null : deps.devices.refresh(bearer);
    if (!next) return send(res, 401, { error: "Token can no longer be refreshed" });
    deps.audit("device.refreshed", { deviceId: device.deviceId });
    send(res, 200, { deviceToken: next.token, expiresAt: next.expiresAt });
  }));

  /**
   * Where to wake this device when its socket is closed (ADR-4).
   * Registers against the calling device, taken from the bearer: a body `deviceId` would let
   * one phone redirect another's wake-ups.
   */
  router.add("POST", "/m/devices/push-token", guarded(async ({ req, res, device }) => {
    const body = await body_(req, res);
    if (body === undefined) return;

    const platform = str(body["platform"]) ?? "fcm";
    // Refused rather than ignored: silently accepting `apns` would leave an operator
    // with a phone that registered successfully and never rings (ADR-9 defers iOS).
    if (platform !== "fcm") {
      return send(res, 400, { error: `Unsupported push platform '${platform}'` });
    }

    const token = str(body["token"]);
    if (token === undefined || token.length === 0) {
      return send(res, 400, { error: "token is required" });
    }
    // A bound on untrusted input that gets written to disk. Real FCM tokens are ~200
    // characters; this is generous and still stops the store being a growth vector.
    if (token.length > MAX_PUSH_TOKEN_LENGTH) {
      return send(res, 400, { error: "token is too long to be a registration token" });
    }

    deps.devices.setPushToken(device.deviceId, token);
    // The token itself is never audited — it is the capability to ring that phone.
    deps.audit("device.push_registered", { deviceId: device.deviceId, platform });
    send(res, 200, { ok: true });
  }));

  /** Opting out, and the path a phone takes when notifications are switched off. */
  router.add("DELETE", "/m/devices/push-token", guarded(async ({ res, device }) => {
    deps.devices.clearPushToken(device.deviceId);
    deps.audit("device.push_cleared", { deviceId: device.deviceId });
    send(res, 200, { ok: true });
  }));

  router.add("DELETE", "/m/devices/:deviceId", guarded(async ({ res, params, device }) => {
    const target = params["deviceId"] ?? "";
    deps.devices.revoke(target);
    deps.audit("device.revoked", { deviceId: device.deviceId, revoked: target });
    send(res, 200, { ok: true });
  }));
}
