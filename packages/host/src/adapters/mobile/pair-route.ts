import { RateLimiter } from "../../core/rate-limiter.js";
import type { Router } from "../../server/router.js";
import { clientKey } from "./client-key.js";
import { parseRefreshKey } from "./refresh-key.js";
import type { HostCaps } from "./events.js";
import { body_, send, str } from "./http-util.js";
import type { MobileRouterDeps } from "./http-routes.js";

/**
 * Redeem attempts one source may burst before `/m/pair` answers 429 (`issues/07`). Below
 * `MAX_PAIRING_ATTEMPTS` (5), or one source would spend the global budget and lock the host out.
 */
export const PAIR_RATE_CAPACITY = 3;

/** One attempt back every ten seconds. Pairing happens rarely; guessing does not. */
export const PAIR_RATE_REFILL_PER_SEC = 0.1;

/**
 * Sources tracked at once. The key comes from a caller-controlled header (`client-key.ts`),
 * so an uncapped map is a memory-exhaustion primitive; the least recently seen is forgotten.
 */
export const PAIR_RATE_MAX_KEYS = 1024;

/**
 * `POST /m/pair` — the only route on this façade that takes no bearer, and since
 * `issues/07` the only unauthenticated door facing the internet. Its guards (throttle,
 * lockout, source key) live beside it, not in the router.
 */
export function addPairRoute(
  router: Router,
  deps: MobileRouterDeps,
  hostCaps: () => HostCaps,
): void {
  const pairLimiter = new RateLimiter({
    capacity: PAIR_RATE_CAPACITY,
    refillPerSec: PAIR_RATE_REFILL_PER_SEC,
    maxKeys: PAIR_RATE_MAX_KEYS,
  });

  router.add("POST", "/m/pair", async (req, res) => {
    // Before the body is read, and before the pairing budget can be spent: a request
    // refused here must cost the host nothing, or the throttle becomes the cheaper way
    // to drive it into lockout.
    const source = clientKey(req);
    if (!pairLimiter.allow(source)) {
      deps.audit("auth.rejected", { route: "/m/pair", reason: "throttled", source });
      return send(res, 429, { error: "Too many pairing attempts" });
    }

    // The lockout is global on purpose (`PAIRING_LOCKOUT_MS`), so it is reported as
    // "come back later" rather than "wrong code" — the phone showing a retry is honest,
    // and a guesser learns nothing about the code they sent.
    if (deps.pairing.lockedUntil() > 0) {
      deps.audit("auth.rejected", { route: "/m/pair", reason: "locked", source });
      return send(res, 429, { error: "Pairing is locked; ask the host for a new code" });
    }

    const body = await body_(req, res);
    if (body === undefined) return;
    const code = str(body["pairingCode"]);
    const name = str(body["deviceName"]) ?? "Unnamed device";
    if (code === undefined) return send(res, 400, { error: "pairingCode is required" });
    // Optional — a phone with no secure lock cannot make one. Refused when present but
    // unreadable, before the code is spent: a pairing that silently dropped the key would
    // leave the phone believing it can renew and the host unable to check it.
    const refreshKey = str(body["refreshKey"]);
    if (refreshKey !== undefined && parseRefreshKey(refreshKey) === null) {
      return send(res, 400, { error: "refreshKey must be a base64 EC P-256 SubjectPublicKeyInfo" });
    }

    const issued = deps.pairing.redeem(code, name, refreshKey);
    if (!issued) {
      deps.audit("auth.rejected", { route: "/m/pair", reason: "invalid", source });
      return send(res, 401, { error: "Pairing code is invalid or expired" });
    }
    deps.audit("device.paired", { deviceId: issued.deviceId, name, refreshKey: refreshKey !== undefined });
    return send(res, 200, {
      deviceToken: issued.token,
      deviceId: issued.deviceId,
      expiresAt: issued.expiresAt,
      hardExpiresAt: issued.hardExpiresAt,
      ...deps.host,
      hostCaps: hostCaps(),
    });
  });
}
