import { describe, expect, it } from "vitest";
import { shouldPreventCanvasDeleteNavigation } from "../canvas-keyboard-guard";

function keyEvent(key: string, target: EventTarget | null, overrides: Partial<KeyboardEvent> = {}) {
  return { key, target, metaKey: false, ctrlKey: false, altKey: false, ...overrides } as KeyboardEvent;
}

describe("canvas keyboard guard", () => {
  it("blocks browser Backspace/Delete navigation from the canvas chrome", () => {
    const target = document.createElement("div");

    expect(shouldPreventCanvasDeleteNavigation(keyEvent("Backspace", target))).toBe(true);
    expect(shouldPreventCanvasDeleteNavigation(keyEvent("Delete", target))).toBe(true);
  });

  it("lets editable targets keep normal text deletion", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");

    expect(shouldPreventCanvasDeleteNavigation(keyEvent("Backspace", input))).toBe(false);
    expect(shouldPreventCanvasDeleteNavigation(keyEvent("Delete", textarea))).toBe(false);
  });

  it("does not intercept modified shortcuts", () => {
    const target = document.createElement("div");

    expect(shouldPreventCanvasDeleteNavigation(keyEvent("Backspace", target, { metaKey: true }))).toBe(false);
    expect(shouldPreventCanvasDeleteNavigation(keyEvent("Delete", target, { ctrlKey: true }))).toBe(false);
  });
});
