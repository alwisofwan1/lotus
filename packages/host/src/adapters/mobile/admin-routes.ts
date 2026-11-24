import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { BUILD_ID } from "../../core/build-id.js";
import type { AuditEvent, Fields } from "../../core/logger.js";
import { Router } from "../../server/router.js";
import type { DeviceStore } from "./device-store.js";
import type { MobileHostIdentity } from "./http-routes.js";
import type { PairingService } from "./pairing.js";

export interface AdminRouterDeps {
  devices: DeviceStore;
  pairing: PairingService;
  /** Shared secret Rust generated and passed at spawn. Read at the config boundary. */
  secret: string;
  host: MobileHostIdentity;
  /** Where the network-facing façade actually bound, or null when it is not up. */
  mobileAddress: () => { host: string; port: number } | null;
  audit: (event: AuditEvent, fields?: Fields) => void;
}

/**
 * The desktop's private control surface, served on loopback only.
 *
 * It exists because `createPairingCode()` is an in-process method: the settings
 * UI cannot reach it, and Rust deliberately holds no device credentials (ADR-5).
 * Keeping it on a separate listener from `/m/*` is the point, not tidiness — the
 * mobile façade binds a tailnet address, so an admin route living there would be
 * callable from the network.
 */
export function buildAdminRouter(deps: AdminRouterDeps): Router {
  const router = new Router();

  const guarded = (
    handler: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => void,
  ) =>
    (req: IncomingMessage, res: ServerResponse, params: Record<string, string>): void => {
      if (!authorized(req, deps.secret)) {
        deps.audit("auth.rejected", { route: path(req) });
        return send(res, 401, { error: "Unauthorized" });
      }
      handler(req, res, params);
    };

  router.add("POST", "/admin/pairing-code", guarded((_req, res) => {
    const { code, expiresAt } = deps.pairing.create();
    // The code itself is deliberately absent from the audit line: the trail
    // records that a credential was minted, not the credential.
    deps.audit("pairing.code_issued", { expiresAt });
    send(res, 200, { code, expiresAt });
  }));

  router.add("GET", "/admin/devices", guarded((_req, res) => {
    send(res, 200, { items: deps.devices.list() });
  }));

  router.add("DELETE", "/admin/devices/:deviceId", guarded((_req, res, params) => {
    const deviceId = params["deviceId"] ?? "";
    // `revoke` no-ops on an unknown id, which would answer 200 for a device that
    // was never there — indistinguishable from a successful revoke to the UI.
    if (!deps.devices.list().some((d) => d.deviceId === deviceId)) {
      return send(res, 404, { error: `Unknown device ${deviceId}` });
    }
    deps.devices.revoke(deviceId);
    deps.audit("device.revoked", { deviceId, via: "admin" });
    send(res, 200, { ok: true, revoked: deviceId });
  }));

  router.add("GET", "/admin/health", guarded((_req, res) => {
    send(res, 200, {
      ok: true,
      // Which build is answering. The whole point of `/admin/health` over `/health` is that
      // this one is authenticated, so it may say something a stranger should not learn.
      build: BUILD_ID,
      ...deps.host,
      // Null distinguishes "façade not bound" from "bound to loopback"; the
      // second looks healthy but no phone can reach it.
      mobile: deps.mobileAddress(),
      deviceCount: deps.devices.list().length,
    });
  }));

  return router;
}

/** Compares the bearer against the admin secret without leaking a prefix match. */
function authorized(req: IncomingMessage, secret: string): boolean {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ") !== true) return false;
  const offered = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(secret, "utf8");
  // Unequal lengths cannot go to `timingSafeEqual`; it throws rather than
  // returning false. Length is not the secret, so comparing it first is safe.
  if (offered.length !== expected.length) return false;
  return timingSafeEqual(offered, expected);
}

function path(req: IncomingMessage): string {
  return (req.url ?? "").split("?")[0] ?? "";
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
