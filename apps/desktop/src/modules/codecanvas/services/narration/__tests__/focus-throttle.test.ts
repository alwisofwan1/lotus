import { describe, expect, it } from "vitest";
import { FOCUS_MIN_GAP_MS, createFocusThrottle } from "../focus-throttle";

const NOW = 1_700_000_000_000;

describe("createFocusThrottle", () => {
  it("lets the first pierce move the camera", () => {
    expect(createFocusThrottle().shouldFocus("node-1", NOW)).toBe(true);
  });

  it("does not let three simultaneous pierces slam the viewport three times", () => {
    // Three agents failing at once is exactly when the user least needs the camera thrashing
    // between them. First one wins; the rest are still SPOKEN, just not chased visually.
    const t = createFocusThrottle();

    expect(t.shouldFocus("node-1", NOW)).toBe(true);
    expect(t.shouldFocus("node-2", NOW + 5)).toBe(false);
    expect(t.shouldFocus("node-3", NOW + 9)).toBe(false);
  });

  it("moves again once the dust has settled", () => {
    const t = createFocusThrottle();
    t.shouldFocus("node-1", NOW);

    expect(t.shouldFocus("node-2", NOW + FOCUS_MIN_GAP_MS + 1)).toBe(true);
  });

  it("never re-focuses a node the camera is already on", () => {
    // A pane that pierces repeatedly is already in view; re-issuing the move is pure jitter.
    const t = createFocusThrottle();
    t.shouldFocus("node-1", NOW);

    expect(t.shouldFocus("node-1", NOW + FOCUS_MIN_GAP_MS + 1)).toBe(false);
  });
});
