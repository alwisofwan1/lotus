import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";

import { clientKey } from "../client-key.js";

function req(headers: Record<string, string | string[]>, remoteAddress = "127.0.0.1"): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

describe("clientKey", () => {
  it("falls back to the socket address when nothing was forwarded", () => {
    expect(clientKey(req({}, "10.0.0.4"))).toBe("ip:10.0.0.4");
  });

  it("prefers Cloudflare's client IP over the tunnel's loopback address", () => {
    expect(clientKey(req({ "cf-connecting-ip": "203.0.113.9" }))).toBe("cf:203.0.113.9");
  });

  it("takes the first hop of x-forwarded-for, not the proxy chain", () => {
    expect(clientKey(req({ "x-forwarded-for": "203.0.113.9, 172.16.0.1" }))).toBe("xff:203.0.113.9");
  });

  it("prefers cf-connecting-ip when both are present", () => {
    const key = clientKey(req({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" }));
    expect(key).toBe("cf:203.0.113.9");
  });

  it("ignores a blank header rather than keying every caller as empty string", () => {
    expect(clientKey(req({ "cf-connecting-ip": "  " }, "10.0.0.4"))).toBe("ip:10.0.0.4");
  });

  it("takes the first value when a header arrives twice", () => {
    expect(clientKey(req({ "x-forwarded-for": ["203.0.113.9", "198.51.100.1"] }))).toBe("xff:203.0.113.9");
  });

  /** Different keys must not collide across sources — an IP is not a Cloudflare IP. */
  it("namespaces each source so they cannot be forged into one another", () => {
    expect(clientKey(req({ "x-forwarded-for": "10.0.0.4" }))).not.toBe(clientKey(req({}, "10.0.0.4")));
  });
});
