"use client";
import { useCallback, useSyncExternalStore } from "react";
import {
  clearVoiceHotkeyOverride,
  getVoiceHotkeyOverrides,
  resetVoiceHotkeyOverrides,
  setVoiceHotkeyOverride,
  subscribeVoiceHotkeys,
  type VoiceHotkeyOverrides,
} from "@/modules/voice-core/voice-hotkeys";
import {
  APP_VOICE_HOTKEY_IDS,
  CANVAS_HOTKEY_COMMANDS,
  type CanvasHotkeyCommandId,
  type CanvasHotkeyOverrides,
} from "../services/canvas-hotkeys";

// User hotkey remappings (command id → chord). Module-level useSyncExternalStore + localStorage,
// SSR-safe, mirroring useCanvasBehaviorSettings / useVoiceInputSettings. Only remappable commands
// with a non-empty string chord survive load-time validation, so tampered storage can't poison it.
// The app voice keys (APP_VOICE_HOTKEY_IDS) are read and written through the Voice Core store and
// merged in, so the editor shows them beside the canvas chords and the canvas key never holds them.

const STORAGE_KEY = "canvas-hotkeys-v1";

const REMAPPABLE_IDS = new Set<string>(
  CANVAS_HOTKEY_COMMANDS.filter((c) => !c.fixed && !APP_VOICE_HOTKEY_IDS[c.id]).map((c) => c.id),
);
const APP_VOICE_ENTRIES = Object.entries(APP_VOICE_HOTKEY_IDS) as Array<[CanvasHotkeyCommandId, keyof VoiceHotkeyOverrides]>;

const EMPTY: CanvasHotkeyOverrides = {};

let state: CanvasHotkeyOverrides = EMPTY;
let voiceOverrides: VoiceHotkeyOverrides | null = null;
let merged: CanvasHotkeyOverrides = EMPTY;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

/** Canvas overrides plus the app voice keys, rebuilt only when either store changed. */
function snapshot(): CanvasHotkeyOverrides {
  const voice = getVoiceHotkeyOverrides();
  if (voice === voiceOverrides && merged !== EMPTY) return merged;
  voiceOverrides = voice;
  const next: CanvasHotkeyOverrides = { ...state };
  for (const [canvasId, voiceId] of APP_VOICE_ENTRIES) {
    const chord = voice[voiceId];
    if (chord) next[canvasId] = chord;
  }
  merged = Object.keys(next).length === 0 ? EMPTY : next;
  return merged;
}

function setState(next: CanvasHotkeyOverrides) {
  state = next;
  merged = EMPTY;
}

function sanitize(parsed: unknown): CanvasHotkeyOverrides {
  if (!parsed || typeof parsed !== "object") return EMPTY;
  const out: CanvasHotkeyOverrides = {};
  for (const [id, chord] of Object.entries(parsed as Record<string, unknown>)) {
    if (REMAPPABLE_IDS.has(id) && typeof chord === "string" && chord.length > 0) {
      out[id as CanvasHotkeyCommandId] = chord;
    }
  }
  return out;
}

function load(): CanvasHotkeyOverrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    return sanitize(JSON.parse(raw));
  } catch {
    return EMPTY;
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

function hydrateOnce() {
  if (hydrated) return;
  hydrated = true;
  const next = load();
  if (next !== state) {
    setState(next);
    emit();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  hydrateOnce();
  const stopVoice = subscribeVoiceHotkeys(listener);
  return () => {
    listeners.delete(listener);
    stopVoice();
  };
}

const getSnapshot = (): CanvasHotkeyOverrides => snapshot();
const getServerSnapshot = (): CanvasHotkeyOverrides => EMPTY;

/** Synchronous read for the non-React keyboard dispatcher. */
export function getCanvasHotkeyOverrides(): CanvasHotkeyOverrides {
  hydrateOnce();
  return snapshot();
}

export function setCanvasHotkeyOverride(id: CanvasHotkeyCommandId, chord: string) {
  hydrateOnce();
  const voiceId = APP_VOICE_HOTKEY_IDS[id];
  if (voiceId) return setVoiceHotkeyOverride(voiceId, chord);
  if (!REMAPPABLE_IDS.has(id) || chord.length === 0 || state[id] === chord) return;
  setState({ ...state, [id]: chord });
  persist();
  emit();
}

/** Remove an override, restoring the command's default binding. */
export function clearCanvasHotkeyOverride(id: CanvasHotkeyCommandId) {
  hydrateOnce();
  const voiceId = APP_VOICE_HOTKEY_IDS[id];
  if (voiceId) return clearVoiceHotkeyOverride(voiceId);
  if (!(id in state)) return;
  const next = { ...state };
  delete next[id];
  setState(next);
  persist();
  emit();
}

/** Restore every command to its default binding. */
export function resetCanvasHotkeyOverrides() {
  hydrateOnce();
  resetVoiceHotkeyOverrides();
  if (Object.keys(state).length === 0) return;
  setState(EMPTY);
  persist();
  emit();
}

/** Test-only: reset the shared store so suites don't leak state. */
export function resetCanvasHotkeyStoreForTests() {
  setState(EMPTY);
  voiceOverrides = null;
  hydrated = false;
  listeners.clear();
}

export interface CanvasHotkeyOverridesController {
  overrides: CanvasHotkeyOverrides;
  setOverride: (id: CanvasHotkeyCommandId, chord: string) => void;
  clearOverride: (id: CanvasHotkeyCommandId) => void;
  resetAll: () => void;
}

export function useCanvasHotkeyOverrides(): CanvasHotkeyOverridesController {
  const overrides = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setOverride = useCallback(
    (id: CanvasHotkeyCommandId, chord: string) => setCanvasHotkeyOverride(id, chord),
    [],
  );
  const clearOverride = useCallback((id: CanvasHotkeyCommandId) => clearCanvasHotkeyOverride(id), []);
  const resetAll = useCallback(() => resetCanvasHotkeyOverrides(), []);
  return { overrides, setOverride, clearOverride, resetAll };
}
