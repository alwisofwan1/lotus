import type { IncomingMessage } from "node:http";

/**
 * Who a request is throttled as.
 *
 * The façade binds loopback and is reached through the private path the machine already
 * has (ADR-C), so `socket.remoteAddress` is `127.0.0.1` for every request that arrives
 * through a tunnel — one bucket for the whole internet, which is the same denial of
 * service the budget in `pairing.ts` used to be.
 *
 * So the forwarded-for headers are read, and the trust argument is spelled out rather
 * than assumed:
 *
 * - Nothing that is not already on this machine can write them, because nothing that is
 *   not already on this machine can open the socket. The only writer is the local tunnel
 *   daemon, which is as trusted as the hop it is.
 * - An attacker who reaches the route CAN put whatever they like in the header, and so
 *   choose their own bucket. That is intended: the worst they achieve is throttling
 *   nobody but themselves. What they must not be able to do is exhaust somebody else's
 *   bucket, and a key they control cannot be the operator's.
 * - Rotating the header defeats the throttle entirely. That is why the throttle is not
 *   the defence — `PAIRING_LOCKOUT_MS` is, and it is global on purpose. This is the
 *   cheap layer that keeps one noisy source from reaching the expensive one.
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
