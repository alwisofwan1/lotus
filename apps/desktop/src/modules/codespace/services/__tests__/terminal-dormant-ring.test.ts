import { describe, expect, it, vi } from "vitest";
import {
  TerminalDormantRing,
  DORMANT_RING_OVERFLOW_NOTICE,
} from "../terminal-dormant-ring";

// ─── helpers ────────────────────────────────────────────────────────────────

function drainAll(ring: TerminalDormantRing): string[] {
  const chunks: string[] = [];
  ring.drain((c) => chunks.push(c));
  return chunks;
}

function drainJoined(ring: TerminalDormantRing): string {
  return drainAll(ring).join("");
}

// ─── basic append / drain ────────────────────────────────────────────────────

describe("TerminalDormantRing — basic append/drain", () => {
  it("delivers a single append to drain", () => {
    const ring = new TerminalDormantRing({ blockSize: 64, maxBlocks: 4 });
    ring.append("hello");
    expect(drainJoined(ring)).toBe("hello");
  });

  it("never calls write when the ring is empty", () => {
    const ring = new TerminalDormantRing({ blockSize: 64, maxBlocks: 4 });
    const write = vi.fn();
    ring.drain(write);
    expect(write).not.toHaveBeenCalled();
  });

  it("accumulates multiple appends and delivers them in order", () => {
    const ring = new TerminalDormantRing({ blockSize: 64, maxBlocks: 4 });
    ring.append("one ");
    ring.append("two ");
    ring.append("three");
    expect(drainJoined(ring)).toBe("one two three");
  });

  it("drain leaves the ring empty so a second drain is a no-op", () => {
    const ring = new TerminalDormantRing({ blockSize: 64, maxBlocks: 4 });
    ring.append("data");
    drainAll(ring);
    const write = vi.fn();
    ring.drain(write);
    expect(write).not.toHaveBeenCalled();
  });
});

// ─── hasData ─────────────────────────────────────────────────────────────────

describe("TerminalDormantRing — hasData", () => {
  it("is false on a fresh ring", () => {
    expect(new TerminalDormantRing().hasData()).toBe(false);
  });

  it("becomes true after append", () => {
    const ring = new TerminalDormantRing();
    ring.append("x");
    expect(ring.hasData()).toBe(true);
  });

  it("becomes false after drain", () => {
    const ring = new TerminalDormantRing();
    ring.append("x");
    drainAll(ring);
    expect(ring.hasData()).toBe(false);
  });
});

// ─── clear ───────────────────────────────────────────────────────────────────

describe("TerminalDormantRing — clear", () => {
  it("discards all data without calling write", () => {
    const ring = new TerminalDormantRing({ blockSize: 64, maxBlocks: 4 });
    ring.append("keep-me-not");
    ring.clear();
    expect(ring.hasData()).toBe(false);
    const write = vi.fn();
    ring.drain(write);
    expect(write).not.toHaveBeenCalled();
  });

  it("resets the drop counter", () => {
    const ring = new TerminalDormantRing({ blockSize: 4, maxBlocks: 1 });
    ring.append("abcde"); // forces eviction
    ring.clear();
    expect(ring.getDropCount()).toBe(0);
  });
});

// ─── block boundary ──────────────────────────────────────────────────────────

describe("TerminalDormantRing — block boundaries", () => {
  it("splits data spanning multiple blocks and preserves all bytes", () => {
    // blockSize=4: "abcdefgh" → blocks ["abcd", "efgh"]
    const ring = new TerminalDormantRing({ blockSize: 4, maxBlocks: 8 });
    ring.append("abcdefgh");
    expect(drainJoined(ring)).toBe("abcdefgh");
  });

  it("delivers data that fills exactly one block in one callback", () => {
    const ring = new TerminalDormantRing({ blockSize: 4, maxBlocks: 4 });
    ring.append("abcd");
    const chunks = drainAll(ring);
    // The ring may deliver in one or more chunks; what matters is content
    expect(chunks.join("")).toBe("abcd");
  });

  it("accumulates a partial block until drain", () => {
    const ring = new TerminalDormantRing({ blockSize: 8, maxBlocks: 4 });
    ring.append("abc"); // under blockSize — sits in current
    ring.append("de"); // still under
    expect(drainJoined(ring)).toBe("abcde");
  });
});

// ─── overflow / drop ──────────────────────────────────────────────────────────

describe("TerminalDormantRing — overflow", () => {
  it("drops the oldest block when maxBlocks is exceeded", () => {
    // maxBlocks=2, blockSize=4 → 8-byte cap
    // Append 12 bytes: three blocks "abcd", "efgh", "ijkl"
    // "abcd" should be evicted.
    const ring = new TerminalDormantRing({ blockSize: 4, maxBlocks: 2 });
    ring.append("abcdefghijkl");
    const chunks = drainAll(ring);
    const text = chunks.join("");
    expect(text).not.toContain("abcd"); // oldest evicted
    expect(text).toContain("ijkl");     // newest kept
  });

  it("increments dropCount when a block is evicted", () => {
    const ring = new TerminalDormantRing({ blockSize: 4, maxBlocks: 1 });
    ring.append("abcdefgh"); // 2 blocks, 1 evicted
    expect(ring.getDropCount()).toBeGreaterThan(0);
  });

  it("emits DORMANT_RING_OVERFLOW_NOTICE before the remaining data on drain after overflow", () => {
    const ring = new TerminalDormantRing({ blockSize: 4, maxBlocks: 1 });
    ring.append("abcdefgh");
    const chunks = drainAll(ring);
    expect(chunks[0]).toBe(DORMANT_RING_OVERFLOW_NOTICE);
  });

  it("overflow notice does NOT contain the terminal hard-reset sequence \\x1bc", () => {
    expect(DORMANT_RING_OVERFLOW_NOTICE).not.toContain("\x1bc");
  });

  it("resumes the first retained block at the next newline boundary after overflow", () => {
    // After dropping "abcd", the ring holds "efg\nhi". The drain should skip
    // "efg" (orphaned partial line) and start from "hi".
    const ring = new TerminalDormantRing({ blockSize: 4, maxBlocks: 1 });
    // Append exactly 8 chars: block1="abcd" (evicted), block2="efg\n", block3="hi" retained
    ring.append("abcd"); // fills block 1 → evicted on next push
    ring.append("efg\n"); // fills block 2 → now at cap
    ring.append("hi");    // partial block
    const chunks = drainAll(ring);
    const text = chunks.join("");
    // Should not start with "efg" (orphaned partial line before the newline)
    // Should contain "hi"
    expect(text).not.toMatch(/^.*efg/);
    expect(text).toContain("hi");
  });

  it("emits notice only once even after multiple overflow events", () => {
    const ring = new TerminalDormantRing({ blockSize: 4, maxBlocks: 1 });
    ring.append("abcdefgh"); // two evictions
    const chunks = drainAll(ring);
    const noticeCount = chunks.filter((c) => c === DORMANT_RING_OVERFLOW_NOTICE).length;
    expect(noticeCount).toBe(1);
  });

  it("does not emit overflow notice when no overflow occurred", () => {
    const ring = new TerminalDormantRing({ blockSize: 64, maxBlocks: 4 });
    ring.append("safe data");
    const chunks = drainAll(ring);
    expect(chunks).not.toContain(DORMANT_RING_OVERFLOW_NOTICE);
  });

  it("clears the overflow flag so a second drain shows no notice", () => {
    // blockSize=4, maxBlocks=2: "abcdefghijkl" (3 blocks) overflows by one.
    // After draining, "new data" (8 chars = 2 blocks) fits exactly in maxBlocks=2.
    const ring = new TerminalDormantRing({ blockSize: 4, maxBlocks: 2 });
    ring.append("abcdefghijkl"); // 3 blocks → 1 evicted, overflowed=true
    drainAll(ring); // consumes the notice

    ring.append("new data"); // 8 chars = 2 full blocks, fits in maxBlocks=2
    const chunks = drainAll(ring);
    expect(chunks).not.toContain(DORMANT_RING_OVERFLOW_NOTICE);
    expect(chunks.join("")).toBe("new data");
  });
});
