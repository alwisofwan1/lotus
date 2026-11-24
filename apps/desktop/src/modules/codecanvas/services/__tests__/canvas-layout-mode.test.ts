import { describe, it, expect } from "vitest";
import { resolveTopControlsMode } from "../canvas-layout-mode";

describe("resolveTopControlsMode", () => {
  it("honours the top-bar preference", () => {
    expect(resolveTopControlsMode({ pref: "top-bar", emptyState: false })).toBe("top-bar");
  });

  it("docks controls into the command bar when the preference asks and nothing forces the top bar", () => {
    expect(resolveTopControlsMode({ pref: "command-bar", emptyState: false })).toBe("command-bar");
  });

  it("forces the top bar back on the empty state (no command bar is rendered without a project)", () => {
    expect(resolveTopControlsMode({ pref: "command-bar", emptyState: true })).toBe("top-bar");
  });

  it("stays top-bar under a top-bar preference even on the empty state", () => {
    expect(resolveTopControlsMode({ pref: "top-bar", emptyState: true })).toBe("top-bar");
  });
});
