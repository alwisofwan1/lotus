import { describe, expect, it, vi } from "vitest";
import { createFleetBriefing } from "../fleet-briefing";

describe("fleetBriefing", () => {
  it("starts off", () => {
    expect(createFleetBriefing().isOn()).toBe(false);
  });

  it("toggles on and back off", () => {
    const briefing = createFleetBriefing();

    briefing.toggle();
    expect(briefing.isOn()).toBe(true);

    briefing.toggle();
    expect(briefing.isOn()).toBe(false);
  });

  it("can be dismissed without knowing whether it was on", () => {
    // Escape clears it, and Escape fires for a great many reasons. Dismiss must be idempotent so
    // the caller never has to check first.
    const briefing = createFleetBriefing();
    briefing.toggle();

    briefing.dismiss();
    briefing.dismiss();

    expect(briefing.isOn()).toBe(false);
  });

  it("notifies subscribers when it changes", () => {
    const briefing = createFleetBriefing();
    const listener = vi.fn();
    briefing.subscribe(listener);

    briefing.toggle();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stays silent on a dismiss that changed nothing", () => {
    // Every card on the board re-renders on a change. Dismissing an already-off briefing must not
    // repaint them.
    const briefing = createFleetBriefing();
    const listener = vi.fn();
    briefing.subscribe(listener);

    briefing.dismiss();

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying after unsubscribe", () => {
    const briefing = createFleetBriefing();
    const listener = vi.fn();
    const off = briefing.subscribe(listener);

    off();
    briefing.toggle();

    expect(listener).not.toHaveBeenCalled();
  });

  it("exposes a version for useSyncExternalStore", () => {
    const briefing = createFleetBriefing();
    const start = briefing.version();

    briefing.toggle();
    const afterToggle = briefing.version();
    briefing.dismiss();
    const afterDismiss = briefing.version();
    briefing.dismiss();

    expect(afterToggle).toBeGreaterThan(start);
    expect(afterDismiss).toBeGreaterThan(afterToggle);
    expect(briefing.version()).toBe(afterDismiss);
  });
});
