import { describe, expect, it, vi } from "vitest";

import { StreamHeartbeat, type Heartbeatable } from "../stream-heartbeat.js";

/**
 * `issues/10`, reopened by a real phone on 2026-09-06.
 *
 * It was written about Cloudflare's idle timeout and deprioritised when Tailscale removed
 * Cloudflare from the path. That closed one of its two halves. The other is that **nobody can
 * tell a dead socket from a quiet one**: with no ping in either direction, a connection the
 * network has silently dropped looks exactly like an idle one, so the host keeps writing to
 * nothing and the phone keeps believing it is subscribed.
 *
 * Measured on devbox-vps: the phone held three established sockets at once, and their ports
 * changed between two readings — it had been reconnecting while every previous socket stayed
 * open on the host, receiving frames nothing would ever read.
 */
const socket = (): Heartbeatable & { pings: number; terminated: number } => ({
  pings: 0,
  terminated: 0,
  ping() { this.pings += 1; },
  terminate() { this.terminated += 1; },
});

describe("StreamHeartbeat", () => {
  it("pings every socket on each tick", () => {
    const a = socket();
    const b = socket();
    const beat = new StreamHeartbeat(() => [a, b]);

    beat.tick();

    expect([a.pings, b.pings]).toEqual([1, 1]);
    expect([a.terminated, b.terminated]).toEqual([0, 0]);
  });

  /** A pong between ticks is the proof of life, and the only one available. */
  it("spares a socket that answered", () => {
    const a = socket();
    const beat = new StreamHeartbeat(() => [a]);

    beat.tick();
    beat.pong(a);
    beat.tick();

    expect(a.terminated).toBe(0);
    expect(a.pings).toBe(2);
  });

  /**
   * A socket that missed a whole interval is gone. Terminating it is what frees the host and —
   * the part that matters to an operator — what lets the phone's own transport see a close and
   * reconnect, instead of sitting on a connection nothing arrives over.
   */
  it("terminates a socket that never answered", () => {
    const a = socket();
    const beat = new StreamHeartbeat(() => [a]);

    beat.tick();
    beat.tick();

    expect(a.terminated).toBe(1);
    // Not pinged again: it is being closed, not asked once more.
    expect(a.pings).toBe(1);
  });

  it("gives a socket its first interval before expecting anything", () => {
    const a = socket();

    new StreamHeartbeat(() => [a]).tick();

    expect(a.terminated).toBe(0);
  });

  /** A socket that comes back after a missed beat is a new socket; the old one stays dead. */
  it("forgets a socket once it is gone, so its slot is not reused", () => {
    const a = socket();
    const beat = new StreamHeartbeat(() => [a]);

    beat.tick();
    beat.tick();
    expect(beat.size()).toBe(0);
  });

  it("stops cleanly, leaving no timer behind", () => {
    vi.useFakeTimers();
    try {
      const a = socket();
      const beat = new StreamHeartbeat(() => [a], 1000);
      beat.start();
      vi.advanceTimersByTime(1000);
      expect(a.pings).toBe(1);

      beat.stop();
      vi.advanceTimersByTime(5000);
      expect(a.pings).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
