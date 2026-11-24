import { describe, expect, it } from "vitest";
import { NARRATION_MAX_AGE_MS, isFreshNarration } from "../narration-freshness";
import type { NarrationEvent } from "../narration-event";

const at = (ts: number, kind: NarrationEvent["kind"] = "tool_pre"): NarrationEvent => ({
  kind,
  tag: "tool_edit",
  neutral: "src/auth.ts",
  paneId: "canvas:projA:a1",
  ts,
});

const NOW = 1_700_000_000_000;

describe("isFreshNarration", () => {
  it("accepts an event that just happened", () => {
    expect(isFreshNarration(at(NOW - 500), NOW)).toBe(true);
  });

  it("rejects an event replayed from the startup drain", () => {
    // The Rust drainer emits every unprocessed drop with an mtime inside DEFAULT_DRAIN_TTL (5 min).
    // A busy agent leaves dozens behind, so opening the app would otherwise narrate minutes of
    // history as if it were happening now. Narrating stale work is worse than saying nothing.
    expect(isFreshNarration(at(NOW - 4 * 60_000), NOW)).toBe(false);
  });

  it("uses a window well inside the drainer's 5-minute TTL", () => {
    // If this window ever grew past the drainer's TTL the gate would be a no-op.
    expect(NARRATION_MAX_AGE_MS).toBeLessThan(5 * 60_000);
  });

  it("treats an event with a future timestamp as fresh rather than dropping it", () => {
    // Clock skew between the hook process and the renderer is real; a slightly-future stamp must
    // not silence a live event.
    expect(isFreshNarration(at(NOW + 2_000), NOW)).toBe(true);
  });
});
