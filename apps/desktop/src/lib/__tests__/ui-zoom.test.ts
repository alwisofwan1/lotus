import { afterEach, describe, expect, it } from "vitest";
import { getUiZoom, isZoomKey, normalizeUiZoom, setUiZoom, stepUiZoom, toWindowRect } from "@/lib/ui-zoom";
import { dragDropHitTestPoints } from "@/modules/codespace/services/terminal-file-drop";

afterEach(() => setUiZoom(1));

describe("ui zoom", () => {
  it("snaps any stored value to a step, and garbage to 100%", () => {
    expect(normalizeUiZoom("1.25")).toBe(1.25);
    expect(normalizeUiZoom(1.13)).toBe(1.1);
    expect(normalizeUiZoom("nope")).toBe(1);
    expect(normalizeUiZoom(null)).toBe(1);
  });

  it("steps and clamps at both ends", () => {
    expect(stepUiZoom(1, 1)).toBe(1.1);
    expect(stepUiZoom(0.9, -1)).toBe(0.9);
    expect(stepUiZoom(1.4, 1)).toBe(1.4);
  });

  it("scales DOM rects to window points for child webviews", async () => {
    const rect = { x: 10, y: 20, width: 100, height: 50, zoomFactor: 0.5 };
    expect(toWindowRect(rect)).toBe(rect);
    await setUiZoom(1.25);
    expect(getUiZoom()).toBe(1.25);
    expect(toWindowRect(rect)).toEqual({ x: 12.5, y: 25, width: 125, height: 62.5, zoomFactor: 0.5 });
    expect(window.localStorage.getItem("lotus-ui-zoom")).toBe("1.25");
  });

  it("maps a native drop point back into zoomed CSS px", () => {
    expect(dragDropHitTestPoints({ x: 125, y: 250 }, 1, 1.25)).toEqual([{ x: 100, y: 200 }]);
    expect(dragDropHitTestPoints({ x: 250, y: 500 }, 2, 1.25)).toEqual([{ x: 200, y: 400 }, { x: 100, y: 200 }]);
  });
});

describe("isZoomKey", () => {
  const press = (key: string, mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {}) => ({
    key, code: "", metaKey: false, ctrlKey: false, altKey: false, ...mods,
  });

  it("zooms on ⌘ on macOS and leaves Ctrl alone there", () => {
    expect(isZoomKey(press("=", { metaKey: true }), "MacIntel")).toBe(1);
    expect(isZoomKey(press("-", { metaKey: true }), "MacIntel")).toBe(-1);
    expect(isZoomKey(press("0", { metaKey: true }), "MacIntel")).toBe(0);
    expect(isZoomKey(press("=", { ctrlKey: true }), "MacIntel")).toBeNull();
  });

  it("zooms on Ctrl on Windows, where there is no ⌘", () => {
    expect(isZoomKey(press("=", { ctrlKey: true }), "Win32")).toBe(1);
    expect(isZoomKey(press("-", { ctrlKey: true }), "Win32")).toBe(-1);
    expect(isZoomKey(press("0", { ctrlKey: true }), "Win32")).toBe(0);
    expect(isZoomKey(press("=", { ctrlKey: true, altKey: true }), "Win32")).toBeNull();
  });
});
