import { afterEach, describe, expect, it } from "vitest";
import {
  clearCanvasHotkeyOverride,
  getCanvasHotkeyOverrides,
  resetCanvasHotkeyOverrides,
  resetCanvasHotkeyStoreForTests,
  setCanvasHotkeyOverride,
} from "./useCanvasHotkeySettings";
import { getVoiceHotkeyBindings, resetVoiceHotkeyStoreForTests, setVoiceHotkeyOverride } from "@/modules/voice-core/voice-hotkeys";

afterEach(() => {
  resetCanvasHotkeyStoreForTests();
  resetVoiceHotkeyStoreForTests();
  try { localStorage.clear(); } catch {}
});

describe("canvas hotkey overrides store", () => {
  it("stores and reads back an override", () => {
    setCanvasHotkeyOverride("jump-labels", "mod+j");
    expect(getCanvasHotkeyOverrides()).toEqual({ "jump-labels": "mod+j" });
  });

  it("clears one override and resets all", () => {
    setCanvasHotkeyOverride("jump-labels", "mod+j");
    setCanvasHotkeyOverride("cycle-forward", "mod+m");
    clearCanvasHotkeyOverride("jump-labels");
    expect(getCanvasHotkeyOverrides()).toEqual({ "cycle-forward": "mod+m" });
    resetCanvasHotkeyOverrides();
    expect(getCanvasHotkeyOverrides()).toEqual({});
  });

  it("refuses to remap a fixed (reserved) command", () => {
    setCanvasHotkeyOverride("exit-layer" as never, "mod+x");
    expect(getCanvasHotkeyOverrides()).toEqual({});
  });

  it("survives a reload, dropping unknown and malformed entries", () => {
    localStorage.setItem(
      "canvas-hotkeys-v1",
      JSON.stringify({ "jump-labels": "mod+j", "exit-layer": "mod+x", bogus: "mod+z", "cycle-forward": 42 }),
    );
    resetCanvasHotkeyStoreForTests();
    expect(getCanvasHotkeyOverrides()).toEqual({ "jump-labels": "mod+j" });
  });

  it("keeps the app voice keys in the app-level voice store, not the canvas key", () => {
    setCanvasHotkeyOverride("app-voice-live", "mod+alt+l");
    expect(getVoiceHotkeyBindings()["live-voice"]).toBe("mod+alt+l");
    expect(localStorage.getItem("canvas-hotkeys-v1")).toBeNull();
    expect(getCanvasHotkeyOverrides()).toEqual({ "app-voice-live": "mod+alt+l" });
    clearCanvasHotkeyOverride("app-voice-live");
    expect(getVoiceHotkeyBindings()["live-voice"]).toBe("mod+shift+l");
  });

  it("shows a voice key changed elsewhere", () => {
    setVoiceHotkeyOverride("push-to-talk", "f5");
    expect(getCanvasHotkeyOverrides()).toEqual({ "app-voice-push-to-talk": "f5" });
  });

  it("reset all also resets the app voice keys", () => {
    setCanvasHotkeyOverride("app-voice-push-to-talk", "f5");
    resetCanvasHotkeyOverrides();
    expect(getVoiceHotkeyBindings()["push-to-talk"]).toBe("alt+shift+space");
  });
});
