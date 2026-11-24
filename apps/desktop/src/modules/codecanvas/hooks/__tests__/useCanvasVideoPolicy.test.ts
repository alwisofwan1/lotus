import { describe, it, expect } from "vitest";
import { computeVideoShouldPlay } from "../useCanvasVideoPolicy";

describe("computeVideoShouldPlay", () => {
  it("plays when visible and motion is allowed", () => {
    expect(computeVideoShouldPlay({ hidden: false, reducedMotion: false })).toBe(true);
  });
  it("pauses when the window is hidden", () => {
    expect(computeVideoShouldPlay({ hidden: true, reducedMotion: false })).toBe(false);
  });
  it("pauses when the user prefers reduced motion", () => {
    expect(computeVideoShouldPlay({ hidden: false, reducedMotion: true })).toBe(false);
  });
  it("pauses when both apply", () => {
    expect(computeVideoShouldPlay({ hidden: true, reducedMotion: true })).toBe(false);
  });
});
