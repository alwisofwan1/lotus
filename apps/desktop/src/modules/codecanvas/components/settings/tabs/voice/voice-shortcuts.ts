"use client";
import { useSyncExternalStore } from "react";
import {
  detectCanvasHotkeyPlatform,
  formatChord,
  UNBOUND_CHORD,
  type CanvasHotkeyPlatform,
} from "@/modules/codecanvas/services/canvas-hotkeys";
import { getVoiceHotkeyBindings, subscribeVoiceHotkeys, VOICE_HOTKEY_DEFAULTS, type VoiceHotkeyBindings } from "@/modules/voice-core/voice-hotkeys";

/** "mac" or "other" for the keycap glyphs; "mac" during prerender. Kept for its importers. */
export function detectPlatform(): CanvasHotkeyPlatform {
  return detectCanvasHotkeyPlatform();
}

/** "⌥Space", or "Unassigned" for a cleared binding. */
export function shortcutLabel(chord: string, platform: CanvasHotkeyPlatform = detectPlatform()): string {
  if (chord === UNBOUND_CHORD) return "Unassigned";
  return formatChord(chord, platform).join(platform === "mac" ? "" : "+");
}

/** The Push-to-Talk and Live Voice keys as the user set them in Hotkeys, kept live. */
export function useVoiceHotkeyLabels(): Record<keyof VoiceHotkeyBindings, string> {
  const bindings = useSyncExternalStore(subscribeVoiceHotkeys, getVoiceHotkeyBindings, () => VOICE_HOTKEY_DEFAULTS);
  return { "push-to-talk": shortcutLabel(bindings["push-to-talk"]), "live-voice": shortcutLabel(bindings["live-voice"]) };
}
