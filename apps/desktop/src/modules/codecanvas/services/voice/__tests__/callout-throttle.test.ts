import { describe, expect, it } from "vitest";
import { CALLOUT_COOLDOWN_MS, createCalloutThrottle } from "../callout-throttle";

describe("createCalloutThrottle", () => {
  it("always emits the first callout for a pane", () => {
    const t = createCalloutThrottle();
    expect(t.tryEmit("a1", 1000, false)).toBe(true);
  });

  it("suppresses a second callout within the cooldown window (no fresh turn)", () => {
    const t = createCalloutThrottle();
    expect(t.tryEmit("a1", 0, false)).toBe(true);
    expect(t.tryEmit("a1", CALLOUT_COOLDOWN_MS - 1, false)).toBe(false);
  });

  it("emits again once the cooldown window has elapsed", () => {
    const t = createCalloutThrottle();
    expect(t.tryEmit("a1", 0, false)).toBe(true);
    expect(t.tryEmit("a1", CALLOUT_COOLDOWN_MS, false)).toBe(true);
  });

  it("a fresh user turn bypasses the cooldown so new work is acknowledged immediately", () => {
    const t = createCalloutThrottle();
    expect(t.tryEmit("a1", 0, false)).toBe(true);
    expect(t.tryEmit("a1", 100, true)).toBe(true); // within window, but user submitted new work
  });

  it("re-arms the window after a fresh-turn emit (a later churn finish is capped again)", () => {
    const t = createCalloutThrottle();
    expect(t.tryEmit("a1", 0, false)).toBe(true);
    expect(t.tryEmit("a1", 100, true)).toBe(true); // fresh turn resets lastAt to 100
    expect(t.tryEmit("a1", 200, false)).toBe(false); // churn within the new window → silent
  });

  it("tracks cooldown per pane independently", () => {
    const t = createCalloutThrottle();
    expect(t.tryEmit("a1", 0, false)).toBe(true);
    expect(t.tryEmit("a2", 0, false)).toBe(true); // different pane, own window
    expect(t.tryEmit("a1", 10, false)).toBe(false);
  });

  it("clear() forgets a pane so its next finish emits immediately", () => {
    const t = createCalloutThrottle();
    expect(t.tryEmit("a1", 0, false)).toBe(true);
    t.clear("a1");
    expect(t.tryEmit("a1", 10, false)).toBe(true);
  });

  it("honors a per-call custom cooldown (the user's setting)", () => {
    const t = createCalloutThrottle();
    expect(t.tryEmit("a1", 0, false, 1000)).toBe(true);
    expect(t.tryEmit("a1", 999, false, 1000)).toBe(false);
    expect(t.tryEmit("a1", 1000, false, 1000)).toBe(true);
  });

  it("a zero cooldown disables the cap — every finish emits", () => {
    const t = createCalloutThrottle();
    expect(t.tryEmit("a1", 0, false, 0)).toBe(true);
    expect(t.tryEmit("a1", 0, false, 0)).toBe(true);
    expect(t.tryEmit("a1", 1, false, 0)).toBe(true);
  });
});
