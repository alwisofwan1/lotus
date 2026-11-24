import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearVoiceHotkeyOverride,
  getVoiceHotkeyBindings,
  planVoiceHotkeyPress,
  resetVoiceHotkeyStoreForTests,
  resolveVoiceHotkey,
  setVoiceHotkeyOverride,
  VOICE_HOTKEY_DEFAULTS,
} from "../voice-hotkeys";

describe("voice hotkeys", () => {
  beforeEach(() => {
    localStorage.clear();
    resetVoiceHotkeyStoreForTests();
  });

  it("starts with Push-to-Talk on ⌥⇧Space and Live Voice on ⌘⇧L", () => {
    expect(getVoiceHotkeyBindings()).toEqual({ "push-to-talk": "alt+shift+space", "live-voice": "mod+shift+l" });
  });

  it("resolves a chord to the voice action bound to it", () => {
    expect(resolveVoiceHotkey("mod+shift+l", VOICE_HOTKEY_DEFAULTS)).toBe("live-voice");
    expect(resolveVoiceHotkey("mod+shift+k", VOICE_HOTKEY_DEFAULTS)).toBeNull();
  });

  it("never resolves an unbound action", () => {
    expect(resolveVoiceHotkey("unbound", VOICE_HOTKEY_DEFAULTS)).toBeNull();
  });

  it("lets a side-specific modifier press reach a generic modifier binding", () => {
    const bindings = { ...VOICE_HOTKEY_DEFAULTS, "push-to-talk": "alt" };
    expect(resolveVoiceHotkey("alt-right", bindings)).toBe("push-to-talk");
  });

  it("keeps a changed key in the app-level voice key", () => {
    setVoiceHotkeyOverride("push-to-talk", "f5");
    expect(getVoiceHotkeyBindings()["push-to-talk"]).toBe("f5");
    expect(JSON.parse(localStorage.getItem("lotus-voice-hotkeys-v1")!)).toEqual({ "push-to-talk": "f5" });
    resetVoiceHotkeyStoreForTests();
    expect(getVoiceHotkeyBindings()["push-to-talk"]).toBe("f5");
  });

  it("restores the default when an override is cleared", () => {
    setVoiceHotkeyOverride("live-voice", "mod+alt+l");
    clearVoiceHotkeyOverride("live-voice");
    expect(getVoiceHotkeyBindings()["live-voice"]).toBe("mod+shift+l");
  });

  it("ignores tampered storage", () => {
    localStorage.setItem("lotus-voice-hotkeys-v1", JSON.stringify({ "live-voice": 5, other: "x" }));
    resetVoiceHotkeyStoreForTests();
    expect(getVoiceHotkeyBindings()).toEqual(VOICE_HOTKEY_DEFAULTS);
  });

  it("runs the mode's handler for the pressed action", () => {
    const liveVoice = vi.fn();
    const press = planVoiceHotkeyPress("live-voice", { liveVoice });
    expect(press.kind).toBe("run");
    if (press.kind === "run") press.run();
    expect(liveVoice).toHaveBeenCalledOnce();
  });

  it("gives a hint instead of silence in a mode without Live Voice", () => {
    expect(planVoiceHotkeyPress("live-voice", { pushToTalk: () => {} })).toEqual({
      kind: "hint",
      text: "Live Voice is not available in this mode yet.",
    });
  });

  it("gives a hint when no mode takes Push-to-Talk", () => {
    expect(planVoiceHotkeyPress("push-to-talk", null)).toEqual({
      kind: "hint",
      text: "Push-to-Talk is not available in this mode yet.",
    });
  });
});
