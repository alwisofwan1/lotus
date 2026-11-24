"use client";
import { modifierOnlyBaseForChord, UNBOUND_CHORD } from "@/lib/hotkeys/chord";
import { readVoiceSetting, VOICE_HOTKEYS_SLOT, writeVoiceSetting } from "./voice-settings-storage";

/**
 * App-level voice hotkeys (stories 15-16, 41): one Push-to-Talk key and one Live Voice key that mean
 * the same thing in every mode. A mode claims them with its own handlers; a press in a mode that does
 * not handle one gets a hint instead of silence. Canvas keeps its own ⌘⇧V / ⌘⇧D overrides in the
 * canvas registry. Chords use the canvas registry format (`@/lib/hotkeys/chord`).
 */
export type VoiceHotkeyId = "push-to-talk" | "live-voice";
export type VoiceHotkeyBindings = Record<VoiceHotkeyId, string>;
export type VoiceHotkeyOverrides = Partial<VoiceHotkeyBindings>;

/** A binding no key press triggers. */
export const VOICE_HOTKEY_UNBOUND = UNBOUND_CHORD;

/**
 * Push-to-Talk defaults to ⌥⇧Space (2026-10-14). It used to ship unbound so nothing was taken from
 * a terminal or the OS, and the cost was that almost nobody found it: the Dictate button's tooltip
 * had no key to name. Not ⌥Space (the mockup's pick): Raycast and ChatGPT claim it. Not fn: the
 * webview never sees it (probed live, no keydown at all). Not ⌃⌥Space: ⌃ normalizes to `mod`, so
 * the tooltip would print ⌘⌥Space, which Finder owns. Settings › Voice still rebinds or clears it.
 */
export const VOICE_HOTKEY_DEFAULTS: VoiceHotkeyBindings = {
  "push-to-talk": "alt+shift+space",
  "live-voice": "mod+shift+l",
};

export const VOICE_HOTKEY_IDS = Object.keys(VOICE_HOTKEY_DEFAULTS) as VoiceHotkeyId[];

/** What the active mode does with each voice hotkey. A missing handler means the mode lacks it. */
export interface VoiceHotkeyHandlers {
  /** `holding` = the key went down and may be held: hold-to-talk if it is not let go early. */
  pushToTalk?: (press?: VoiceHotkeyPressInfo) => void;
  /**
   * The Push-to-Talk key let go after being HELD (at least {@link PUSH_TO_TALK_HOLD_MS}). A mode that
   * passes it gets hold-to-talk on top of tap-to-toggle; one that does not keeps the plain toggle.
   */
  pushToTalkRelease?: () => void;
  /** The Push-to-Talk key let go before {@link PUSH_TO_TALK_HOLD_MS}: that press was a tap. */
  pushToTalkTap?: () => void;
  liveVoice?: () => void;
}

export interface VoiceHotkeyPressInfo {
  holding: boolean;
}

/** A press held this long is hold-to-talk: letting go stops. A shorter one is a tap and toggles. */
export const PUSH_TO_TALK_HOLD_MS = 350;

export type VoiceHotkeyPress = { kind: "run"; run: (press?: VoiceHotkeyPressInfo) => void } | { kind: "hint"; text: string };

const HANDLER_OF: Record<VoiceHotkeyId, keyof VoiceHotkeyHandlers> = {
  "push-to-talk": "pushToTalk",
  "live-voice": "liveVoice",
};

export const VOICE_HOTKEY_HINTS: Record<VoiceHotkeyId, string> = {
  "push-to-talk": "Push-to-Talk is not available in this mode yet.",
  "live-voice": "Live Voice is not available in this mode yet.",
};

/** The voice action a chord triggers. A side-specific modifier also matches a generic one. */
export function resolveVoiceHotkey(chord: string, bindings: VoiceHotkeyBindings): VoiceHotkeyId | null {
  if (chord === VOICE_HOTKEY_UNBOUND) return null;
  const exact = VOICE_HOTKEY_IDS.find((id) => bindings[id] === chord);
  if (exact) return exact;
  const base = modifierOnlyBaseForChord(chord);
  if (!base || base === chord) return null;
  return VOICE_HOTKEY_IDS.find((id) => bindings[id] === base) ?? null;
}

/** Run the mode's handler for a press, or a hint when the mode does not have that action. */
export function planVoiceHotkeyPress(id: VoiceHotkeyId, handlers: VoiceHotkeyHandlers | null): VoiceHotkeyPress {
  const handler = handlers?.[HANDLER_OF[id]];
  return handler ? { kind: "run", run: handler } : { kind: "hint", text: VOICE_HOTKEY_HINTS[id] };
}

// Store: module-level + localStorage, like the other voice settings stores (read through the canvas hotkey store).

const EMPTY: VoiceHotkeyOverrides = {};
let overrides: VoiceHotkeyOverrides = EMPTY;
let bindings: VoiceHotkeyBindings = VOICE_HOTKEY_DEFAULTS;
let hydrated = false;
const listeners = new Set<() => void>();

function sanitize(value: unknown): VoiceHotkeyOverrides {
  if (!value || typeof value !== "object") return EMPTY;
  const out: VoiceHotkeyOverrides = {};
  for (const id of VOICE_HOTKEY_IDS) {
    const chord = (value as Record<string, unknown>)[id];
    if (typeof chord === "string" && chord.length > 0) out[id] = chord;
  }
  return out;
}

function apply(next: VoiceHotkeyOverrides) {
  overrides = next;
  bindings = { ...VOICE_HOTKEY_DEFAULTS, ...next };
}

function hydrateOnce() {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = readVoiceSetting(VOICE_HOTKEYS_SLOT);
    apply(raw ? sanitize(JSON.parse(raw)) : EMPTY);
  } catch {
    apply(EMPTY);
  }
}

function commit(next: VoiceHotkeyOverrides) {
  apply(next);
  writeVoiceSetting(VOICE_HOTKEYS_SLOT, JSON.stringify(next));
  listeners.forEach((listener) => listener());
}

/** Synchronous read for the key listener. */
export function getVoiceHotkeyBindings(): VoiceHotkeyBindings {
  hydrateOnce();
  return bindings;
}

export function getVoiceHotkeyOverrides(): VoiceHotkeyOverrides {
  hydrateOnce();
  return overrides;
}

export function setVoiceHotkeyOverride(id: VoiceHotkeyId, chord: string): void {
  hydrateOnce();
  if (chord.length === 0 || overrides[id] === chord) return;
  commit({ ...overrides, [id]: chord });
}

export function clearVoiceHotkeyOverride(id: VoiceHotkeyId): void {
  hydrateOnce();
  if (!(id in overrides)) return;
  const next = { ...overrides };
  delete next[id];
  commit(next);
}

export function resetVoiceHotkeyOverrides(): void {
  hydrateOnce();
  if (Object.keys(overrides).length === 0) return;
  commit(EMPTY);
}

export function subscribeVoiceHotkeys(listener: () => void): () => void {
  listeners.add(listener);
  hydrateOnce();
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: reset the shared store so suites don't leak state. */
export function resetVoiceHotkeyStoreForTests(): void {
  apply(EMPTY);
  hydrated = false;
  listeners.clear();
}
