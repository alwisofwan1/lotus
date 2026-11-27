import type { IncomingMessage } from "node:http";

/**
 * Who a request is throttled as. Behind a tunnel `remoteAddress` is always `127.0.0.1`
 * (ADR-C), so forwarded-for is read; an attacker can only pick their own bucket. Rotating
 * defeats it, so the global `PAIRING_LOCKOUT_MS` is the real defence.
 */
export function clientKey(req: IncomingMessage): string {
  const cf = header(req, "cf-connecting-ip");
  if (cf !== undefined) return `cf:${cf}`;

  // First hop is the client; the rest were added by proxies along the way.
  const forwarded = header(req, "x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded !== undefined && forwarded.length > 0) return `xff:${forwarded}`;

  return `ip:${req.socket?.remoteAddress ?? "unknown"}`;
}

/** Node lowercases header names; an array means the header was sent more than once. */
function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
