import { describe, it, expect } from "vitest";
import { createLatencyTrace } from "../nl-latency";

/** Deterministic fake clock: returns each queued timestamp in order. */
function fakeClock(times: number[]): () => number {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
}

describe("createLatencyTrace", () => {
  it("records per-stage deltas and a total, rounded to ms", () => {
    // start=1000, parse mark=1320, refine mark=3420, apply mark=3425, summary now=3425
    const trace = createLatencyTrace(fakeClock([1000, 1320, 3420, 3425, 3425]));
    trace.mark("parse");
    trace.mark("refine");
    trace.mark("apply");
    const s = trace.summary();
    expect(s).toContain("parse=320ms");
    expect(s).toContain("refine=2100ms");
    expect(s).toContain("apply=5ms");
    expect(s).toContain("total=2425ms");
    expect(s).toContain("[nl-latency]");
  });

  it("handles a trace with no marks (total only)", () => {
    const trace = createLatencyTrace(fakeClock([500, 980]));
    expect(trace.summary()).toBe("[nl-latency] total=480ms");
  });

  it("exposes the slowest stage for quick triage", () => {
    const trace = createLatencyTrace(fakeClock([0, 100, 2000, 2010, 2010]));
    trace.mark("parse");
    trace.mark("refine");
    trace.mark("apply");
    expect(trace.slowest()).toEqual({ label: "refine", ms: 1900 });
  });
});
