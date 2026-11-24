import { describe, expect, it } from "vitest";
import { shouldRecoverCanvasBrowser, decideCanvasBrowserRepair } from "../canvas-browser-health";

const base = {
  browserState: "active" as const,
  suspended: false,
  url: "https://www.youtube.com/",
  webviewOpen: false,
};

describe("shouldRecoverCanvasBrowser", () => {
  it("recovers an active node whose native WebView is absent (the black-pane bug)", () => {
    expect(shouldRecoverCanvasBrowser(base)).toBe(true);
  });

  it("does not recover when the WebView is actually open", () => {
    expect(shouldRecoverCanvasBrowser({ ...base, webviewOpen: true })).toBe(false);
  });

  it("does not recover while the node is intentionally suspended (gesture/overlay/LOD park)", () => {
    // A suspended WebView is parked off-screen on purpose; its 'absence' is expected
    // and re-opening would fight the park logic.
    expect(shouldRecoverCanvasBrowser({ ...base, suspended: true })).toBe(false);
  });

  it("does not recover a loading node (its own overlay/auto-open path owns it)", () => {
    expect(shouldRecoverCanvasBrowser({ ...base, browserState: "loading" })).toBe(false);
  });

  it("does not recover a disconnected node (already shows recovery UI)", () => {
    expect(shouldRecoverCanvasBrowser({ ...base, browserState: "disconnected" })).toBe(false);
  });

  it("does not recover when there is no real page to be live on", () => {
    expect(shouldRecoverCanvasBrowser({ ...base, url: "about:blank" })).toBe(false);
    expect(shouldRecoverCanvasBrowser({ ...base, url: "" })).toBe(false);
    expect(shouldRecoverCanvasBrowser({ ...base, url: "   " })).toBe(false);
  });
});

const repairBase = {
  browserState: "active" as const,
  suspended: false,
  url: "https://www.youtube.com/",
  open: true,
  viewportParked: false,
};

describe("decideCanvasBrowserRepair", () => {
  it("resyncs bounds when the WebView is open but parked off-screen while the node is visible (recurrence black-pane)", () => {
    // The dominant recurrence: the WebView exists (so existence-only recovery
    // never fires) but sits at PARKED_BOUNDS behind a green 'Live' dot. The
    // repair is to re-push live bounds, not to re-open the page.
    expect(decideCanvasBrowserRepair({ ...repairBase, viewportParked: true })).toBe("resync-bounds");
  });

  it("reopens when the WebView is absent (original teardown black-pane)", () => {
    expect(decideCanvasBrowserRepair({ ...repairBase, open: false })).toBe("reopen");
  });

  it("does nothing when the WebView is open and covering the node", () => {
    expect(decideCanvasBrowserRepair(repairBase)).toBe("none");
  });

  it("does nothing while the node is intentionally suspended, even if parked", () => {
    // A gesture/overlay/LOD park SHOULD leave the WebView parked; repairing it
    // would fight the suspend logic and smear the WebView over the overlay.
    expect(decideCanvasBrowserRepair({ ...repairBase, suspended: true, viewportParked: true })).toBe("none");
    expect(decideCanvasBrowserRepair({ ...repairBase, suspended: true, open: false })).toBe("none");
  });

  it("does nothing for a non-active node (loading/disconnected own their own paths)", () => {
    expect(decideCanvasBrowserRepair({ ...repairBase, browserState: "loading", open: false })).toBe("none");
    expect(decideCanvasBrowserRepair({ ...repairBase, browserState: "disconnected", viewportParked: true })).toBe("none");
  });

  it("does nothing when there is no real page to be live on", () => {
    expect(decideCanvasBrowserRepair({ ...repairBase, url: "about:blank", open: false })).toBe("none");
    expect(decideCanvasBrowserRepair({ ...repairBase, url: "", viewportParked: true })).toBe("none");
    expect(decideCanvasBrowserRepair({ ...repairBase, url: "   ", open: false })).toBe("none");
  });
});
