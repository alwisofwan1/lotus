import { describe, it, expect } from "vitest";

import { RateLimiter } from "../rate-limiter.js";

describe("RateLimiter", () => {
  it("allows up to capacity in a burst, then blocks", () => {
    const limiter = new RateLimiter({ capacity: 3, refillPerSec: 1, now: () => 0 });
    expect(limiter.allow("u")).toBe(true);
    expect(limiter.allow("u")).toBe(true);
    expect(limiter.allow("u")).toBe(true);
    expect(limiter.allow("u")).toBe(false);
  });

  it("refills tokens over elapsed time", () => {
    let t = 0;
    const limiter = new RateLimiter({ capacity: 2, refillPerSec: 1, now: () => t });
    expect(limiter.allow("u")).toBe(true);
    expect(limiter.allow("u")).toBe(true);
    expect(limiter.allow("u")).toBe(false);
    t = 1000; // one second → one token refilled
    expect(limiter.allow("u")).toBe(true);
    expect(limiter.allow("u")).toBe(false);
  });

  it("never refills beyond capacity", () => {
    let t = 0;
    const limiter = new RateLimiter({ capacity: 2, refillPerSec: 1, now: () => t });
    t = 10_000; // long idle
    expect(limiter.allow("u")).toBe(true);
    expect(limiter.allow("u")).toBe(true);
    expect(limiter.allow("u")).toBe(false);
  });

  it("tracks keys independently", () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSec: 1, now: () => 0 });
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
    expect(limiter.allow("b")).toBe(true);
  });

  it("rejects non-positive configuration", () => {
    expect(() => new RateLimiter({ capacity: 0, refillPerSec: 1 })).toThrow();
    expect(() => new RateLimiter({ capacity: 1, refillPerSec: 0 })).toThrow();
  });

  /**
   * `/m/pair` faces the internet since `issues/07`, and its key comes from a header the
   * caller controls (`clientKey`). Unbounded, that Map is a memory exhaustion primitive:
   * one request per forged source, forever.
   */
  it("evicts the least recently seen key once the bucket count is capped", () => {
    let t = 0;
    const limiter = new RateLimiter({ capacity: 1, refillPerSec: 1, maxKeys: 2, now: () => t });

    limiter.allow("a");
    t += 1;
    limiter.allow("b");
    t += 1;
    limiter.allow("c");

    // "a" was evicted, so it starts fresh; "c" is still spent.
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("c")).toBe(false);
  });

  it("keeps a key alive by using it, not by having arrived first", () => {
    let t = 0;
    const limiter = new RateLimiter({ capacity: 1, refillPerSec: 0.0001, maxKeys: 2, now: () => t });

    limiter.allow("a");
    limiter.allow("b");
    t += 1;
    limiter.allow("a"); // refused, but it makes "a" the most recently seen
    t += 1;
    limiter.allow("c"); // evicts "b", the oldest

    // Order matters: each call re-inserts its key, so asserting "a" first keeps the
    // eviction under test the one "c" caused.
    expect(limiter.allow("a")).toBe(false); // still tracked, still empty
    expect(limiter.allow("b")).toBe(true); // evicted, so its spent bucket is gone
  });
});