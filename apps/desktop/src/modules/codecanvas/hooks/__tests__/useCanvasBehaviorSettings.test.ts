import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_CANVAS_BEHAVIOR,
  getCanvasBehaviorSettings,
  resetCanvasBehaviorStoreForTests,
  setCanvasBehaviorSetting,
} from "../useCanvasBehaviorSettings";

const STORAGE_KEY = "canvas-behavior-settings-v1";

describe("useCanvasBehaviorSettings store", () => {
  beforeEach(() => {
    localStorage.clear();
    resetCanvasBehaviorStoreForTests();
  });

  it("ships sensible defaults (agent-control off, focus on, restore on, elevate off, tidy-on-open on, tidy-on-close off, auto-arrange-notes on, animations on, layout preserves today's chrome)", () => {
    expect(getCanvasBehaviorSettings()).toEqual(DEFAULT_CANVAS_BEHAVIOR);
    expect(DEFAULT_CANVAS_BEHAVIOR).toEqual({
      allowAgentCanvasControl: false,
      allowAgentCanvasDraw: false,
      autoFocusNewNodes: true,
      restoreViewportOnOpen: true,
      liveNarration: false,
      tidyMode: "open",
      canvasAnimations: true,
      showToolRail: true,
      topControls: "top-bar",
      commandBarRest: "slab",
      terminalShiftEnterNewline: true,
      toastPosition: "bottom-right",
      completionToastAutoDismiss: true,
      autoOpenBrowserOnDevServer: true,
    });
  });

  it.each([
    [{ tidyOnOpen: true, tidyOnClose: false, autoArrangeNotes: true }, "open"],
    [{ tidyOnOpen: true, tidyOnClose: true, autoArrangeNotes: true }, "open-close"],
    [{ tidyOnOpen: false, tidyOnClose: false, autoArrangeNotes: true }, "notes"],
    [{ tidyOnOpen: false, tidyOnClose: false, autoArrangeNotes: false }, "off"],
    [{ tidyOnOpen: false }, "notes"],
    [{ autoArrangeNotes: false }, "open"],
  ])("migrates legacy tidy flags %j to %s", (legacy, expected) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(legacy));
    resetCanvasBehaviorStoreForTests();
    expect(getCanvasBehaviorSettings().tidyMode).toBe(expected);
  });

  it("persists a changed flag to localStorage and reflects it on the getter", () => {
    setCanvasBehaviorSetting("autoFocusNewNodes", false);
    expect(getCanvasBehaviorSettings().autoFocusNewNodes).toBe(false);
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(raw.autoFocusNewNodes).toBe(false);
  });

  it("hydrates from a persisted value on first read", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ showToolRail: false }));
    resetCanvasBehaviorStoreForTests();
    expect(getCanvasBehaviorSettings().showToolRail).toBe(false);
    // A flag absent from storage falls back to its default, not undefined.
    expect(getCanvasBehaviorSettings().autoFocusNewNodes).toBe(true);
  });

  it("ignores malformed storage and returns defaults", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    resetCanvasBehaviorStoreForTests();
    expect(getCanvasBehaviorSettings()).toEqual(DEFAULT_CANVAS_BEHAVIOR);
  });

  it("persists and hydrates the string topControls setting", () => {
    setCanvasBehaviorSetting("topControls", "command-bar");
    expect(getCanvasBehaviorSettings().topControls).toBe("command-bar");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).topControls).toBe("command-bar");
    resetCanvasBehaviorStoreForTests();
    expect(getCanvasBehaviorSettings().topControls).toBe("command-bar"); // survives reload
  });

  it("rejects an invalid persisted topControls and falls back to the default", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ topControls: "sidebar" }));
    resetCanvasBehaviorStoreForTests();
    expect(getCanvasBehaviorSettings().topControls).toBe("top-bar");
  });

  it("persists and hydrates the string commandBarRest setting", () => {
    setCanvasBehaviorSetting("commandBarRest", "veil");
    expect(getCanvasBehaviorSettings().commandBarRest).toBe("veil");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).commandBarRest).toBe("veil");
    resetCanvasBehaviorStoreForTests();
    expect(getCanvasBehaviorSettings().commandBarRest).toBe("veil"); // survives reload
  });

  it("rejects an invalid persisted commandBarRest and falls back to the default", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ commandBarRest: "glass" }));
    resetCanvasBehaviorStoreForTests();
    expect(getCanvasBehaviorSettings().commandBarRest).toBe("slab");
  });

  it("loads a settings blob that predates commandBarRest with the field defaulted (forward-compat merge)", () => {
    // Simulates a value persisted by an older build of this store, before commandBarRest existed.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ topControls: "command-bar" }));
    resetCanvasBehaviorStoreForTests();
    expect(getCanvasBehaviorSettings().commandBarRest).toBe("slab");
    expect(getCanvasBehaviorSettings().topControls).toBe("command-bar");
  });

  it("persists the boolean showToolRail flag", () => {
    setCanvasBehaviorSetting("showToolRail", false);
    expect(getCanvasBehaviorSettings().showToolRail).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).showToolRail).toBe(false);
  });

  it("persists the boolean terminalShiftEnterNewline flag and survives reload", () => {
    setCanvasBehaviorSetting("terminalShiftEnterNewline", false);
    expect(getCanvasBehaviorSettings().terminalShiftEnterNewline).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).terminalShiftEnterNewline).toBe(false);
    resetCanvasBehaviorStoreForTests();
    expect(getCanvasBehaviorSettings().terminalShiftEnterNewline).toBe(false);
  });

  it("sanitizes a non-boolean persisted terminalShiftEnterNewline back to the default", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ terminalShiftEnterNewline: "yes" }));
    resetCanvasBehaviorStoreForTests();
    expect(getCanvasBehaviorSettings().terminalShiftEnterNewline).toBe(true);
  });

  it("persists the completion-toast auto-dismiss preference and defaults it on", () => {
    expect(getCanvasBehaviorSettings().completionToastAutoDismiss).toBe(true);
    setCanvasBehaviorSetting("completionToastAutoDismiss", false);
    expect(getCanvasBehaviorSettings().completionToastAutoDismiss).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).completionToastAutoDismiss).toBe(false);
    resetCanvasBehaviorStoreForTests();
    expect(getCanvasBehaviorSettings().completionToastAutoDismiss).toBe(false);
  });

  it("defaults toastPosition to bottom-right", () => {
    expect(getCanvasBehaviorSettings().toastPosition).toBe("bottom-right");
  });

  it("persists and hydrates the string toastPosition setting", () => {
    setCanvasBehaviorSetting("toastPosition", "top-left");
    expect(getCanvasBehaviorSettings().toastPosition).toBe("top-left");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).toastPosition).toBe("top-left");
    resetCanvasBehaviorStoreForTests();
    expect(getCanvasBehaviorSettings().toastPosition).toBe("top-left"); // survives reload
  });

  it("rejects an invalid persisted toastPosition and falls back to the default", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ toastPosition: "middle" }));
    resetCanvasBehaviorStoreForTests();
    expect(getCanvasBehaviorSettings().toastPosition).toBe("bottom-right");
  });
});

describe("live narration toggle", () => {
  it("is OFF by default — narration is opt-in", () => {
    // With one agent working the router speaks every tool call. Nobody gets that without asking.
    expect(DEFAULT_CANVAS_BEHAVIOR.liveNarration).toBe(false);
  });
});
