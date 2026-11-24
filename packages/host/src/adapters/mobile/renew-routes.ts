import { RateLimiter } from "../../core/rate-limiter.js";
import type { AuditEvent, Fields } from "../../core/logger.js";
import type { Router } from "../../server/router.js";
import { clientKey } from "./client-key.js";
import type { DeviceStore } from "./device-store.js";
import { body_, send, str } from "./http-util.js";
import { RenewalService } from "./renewal.js";

/** Same shape as `/m/pair`'s throttle: a renewal is rare, a guesser is not. */
export const RENEW_RATE_CAPACITY = 5;
export const RENEW_RATE_REFILL_PER_SEC = 0.1;
export const RENEW_RATE_MAX_KEYS = 1024;

export interface RenewRouteDeps {
  devices: DeviceStore;
  audit: (event: AuditEvent, fields?: Fields) => void;
  now?: () => number;
}

/**
 * `/m/devices/renew*` — the way back in for a device whose bearer lapsed, without a new
 * pairing code. No bearer, by construction: the bearer is what lapsed. What stands in
 * for it is a signature from the hardware key registered at pairing, over a nonce this
 * host just issued. Unknown device, missing key, stale nonce and bad signature all answer
 * the same 401, so the route says nothing about which device ids exist.
 */
export function addRenewRoutes(router: Router, deps: RenewRouteDeps): void {
  const renewal = new RenewalService(deps.devices, deps.now);
  const limiter = new RateLimiter({
    capacity: RENEW_RATE_CAPACITY,
    refillPerSec: RENEW_RATE_REFILL_PER_SEC,
    maxKeys: RENEW_RATE_MAX_KEYS,
  });

  const refused = (res: Parameters<typeof send>[0], route: string, reason: string, source: string) => {
    deps.audit("auth.rejected", { route, reason, source });
    send(res, 401, { error: "Renewal refused; pair again" });
  };

  router.add("POST", "/m/devices/renew/challenge", async (req, res) => {
    const source = clientKey(req);
    if (!limiter.allow(source)) return send(res, 429, { error: "Too many renewal attempts" });
    const body = await body_(req, res);
    if (body === undefined) return;
    const deviceId = str(body["deviceId"]);
    if (deviceId === undefined) return send(res, 400, { error: "deviceId is required" });

    const challenge = renewal.challenge(deviceId);
    if (challenge === null) return refused(res, "/m/devices/renew/challenge", "no-key", source);
    send(res, 200, challenge);
  });

  router.add("POST", "/m/devices/renew", async (req, res) => {
    const source = clientKey(req);
    if (!limiter.allow(source)) return send(res, 429, { error: "Too many renewal attempts" });
    const body = await body_(req, res);
    if (body === undefined) return;
    const deviceId = str(body["deviceId"]);
    const nonce = str(body["nonce"]);
    const signature = str(body["signature"]);
    if (deviceId === undefined || nonce === undefined || signature === undefined) {
      return send(res, 400, { error: "deviceId, nonce and signature are required" });
    }

    const issued = renewal.renew(deviceId, nonce, signature);
    if (issued === null) return refused(res, "/m/devices/renew", "signature", source);
    deps.audit("device.renewed", { deviceId });
    send(res, 200, {
      deviceToken: issued.token,
      expiresAt: issued.expiresAt,
      hardExpiresAt: issued.hardExpiresAt,
    });
  });
}
