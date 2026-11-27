export interface RateLimiterOptions {
  /** Maximum burst — tokens available when fully refilled. */
  capacity: number;
  /** Tokens replenished per second. */
  refillPerSec: number;
  /** Injectable clock in ms (defaults to Date.now). */
  now?: () => number;
  /** Cap caller-controlled keys so forged sources cannot grow the limiter without bound. */
  maxKeys?: number;
}

interface Bucket {
  tokens: number;
  last: number;
}

/**
 * Per-key token-bucket rate limiter. Keyed by an arbitrary string (e.g. a
 * Telegram user id); each key gets an independent bucket that refills over
 * time. Pure aside from the injected clock — fully unit-testable.
 */
export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private readonly maxKeys: number | undefined;
  /** Insertion order is the eviction order, so a re-seen key is re-inserted below. */
  private readonly buckets = new Map<string, Bucket>();

  constructor(opts: RateLimiterOptions) {
    if (opts.capacity <= 0) throw new Error("capacity must be > 0");
    if (opts.refillPerSec <= 0) throw new Error("refillPerSec must be > 0");
    this.capacity = opts.capacity;
    this.refillPerMs = opts.refillPerSec / 1000;
    this.now = opts.now ?? (() => Date.now());
    if (opts.maxKeys !== undefined && opts.maxKeys <= 0) throw new Error("maxKeys must be > 0");
    this.maxKeys = opts.maxKeys;
  }

  /** Consumes one token for `key`; returns false when the bucket is empty. */
  allow(key: string): boolean {
    const t = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, last: t };
    const refill = (t - bucket.last) * this.refillPerMs;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + refill);
    bucket.last = t;

    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    // Delete before set so the key moves to the end of the Map's insertion order —
    // that ordering IS the recency list the eviction below walks.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    this.evictOverflow();
    return allowed;
  }

  /** Number of keys currently tracked. */
  size(): number {
    return this.buckets.size;
  }

  private evictOverflow(): void {
    if (this.maxKeys === undefined) return;
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next();
      if (oldest.done === true) return;
      this.buckets.delete(oldest.value);
    }
  }
}
