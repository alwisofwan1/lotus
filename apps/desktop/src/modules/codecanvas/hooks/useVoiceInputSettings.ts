"use client";
import { useCallback, useSyncExternalStore } from "react";
import { DEFAULT_VOICE_INPUT, type VoiceInputSettings } from "@/modules/codecanvas/services/voice/voice-mode";
import { DICTATION_MODES, type DictationModeId } from "@/modules/codecanvas/services/voice/dictation-mode";
import { readVoiceSetting, VOICE_INPUT_SLOT, writeVoiceSetting, type VoiceSettingsSlot } from "@/modules/voice-core/voice-settings-storage";

// Device-level voice-input preferences (mode default, auto-submit, word floor) for the NL command bar.
// Module-level useSyncExternalStore + localStorage, SSR-safe, mirroring useCanvasBehaviorSettings.
// Persists what the user picks in Settings → Voice; the command bar reads the active mode live.
// Stored under the app-level voice key; the old canvas key is carried over once (Voice Core).

let state: VoiceInputSettings = DEFAULT_VOICE_INPUT;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

/** Code's own switch before Send Right Away was one setting (ADR-0064); read once, for the migration. */
const CODE_VOICE_SLOT: VoiceSettingsSlot = { key: "lotus-code-voice-v1" };

function wasOn(slot: VoiceSettingsSlot, field: string): boolean {
  try {
    const raw = readVoiceSetting(slot);
    return raw ? (JSON.parse(raw) as Record<string, unknown>)[field] === true : false;
  } catch {
    return false;
  }
}

/**
 * Canvas's "Auto-send dictation" and Code's "Send right away" became one **Send Right Away**. Whoever
 * had either on keeps it on. The result is written back, so this runs once: after that the stored
 * value is the setting, and turning it off sticks.
 */
function migrateSendRightAway(parsed: Partial<VoiceInputSettings> & { dictateAutoSubmit?: unknown }): VoiceInputSettings | null {
  if (typeof parsed.sendRightAway === "boolean") return null;
  const on = parsed.dictateAutoSubmit === true || wasOn(CODE_VOICE_SLOT, "sendRightAway");
  const migrated = { ...parse(parsed), sendRightAway: on };
  writeVoiceSetting(VOICE_INPUT_SLOT, JSON.stringify(migrated));
  return migrated;
}

function load(): VoiceInputSettings {
  try {
    const raw = readVoiceSetting(VOICE_INPUT_SLOT);
    const parsed = (raw ? JSON.parse(raw) : {}) as Partial<VoiceInputSettings>;
    if (!raw && !wasOn(CODE_VOICE_SLOT, "sendRightAway")) return DEFAULT_VOICE_INPUT;
    return migrateSendRightAway(parsed) ?? parse(parsed);
  } catch {
    return DEFAULT_VOICE_INPUT;
  }
}

function parse(parsed: Partial<VoiceInputSettings>): VoiceInputSettings {
  return {
    autoSubmit: typeof parsed.autoSubmit === "boolean" ? parsed.autoSubmit : DEFAULT_VOICE_INPUT.autoSubmit,
    minWordsToSubmit:
      typeof parsed.minWordsToSubmit === "number" && Number.isFinite(parsed.minWordsToSubmit)
        ? Math.max(1, Math.floor(parsed.minWordsToSubmit))
        : DEFAULT_VOICE_INPUT.minWordsToSubmit,
    polish: typeof parsed.polish === "boolean" ? parsed.polish : DEFAULT_VOICE_INPUT.polish,
    autoCleanup: typeof parsed.autoCleanup === "boolean" ? parsed.autoCleanup : DEFAULT_VOICE_INPUT.autoCleanup,
    dictationMode:
      typeof parsed.dictationMode === "string" && parsed.dictationMode in DICTATION_MODES
        ? (parsed.dictationMode as DictationModeId)
        : DEFAULT_VOICE_INPUT.dictationMode,
    sendRightAway: typeof parsed.sendRightAway === "boolean" ? parsed.sendRightAway : DEFAULT_VOICE_INPUT.sendRightAway,
  };
}

function hydrateOnce() {
  if (hydrated) return;
  hydrated = true;
  const next = load();
  if (next !== state) {
    state = next;
    emit();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  hydrateOnce();
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = (): VoiceInputSettings => state;
const getServerSnapshot = (): VoiceInputSettings => DEFAULT_VOICE_INPUT;

/** Synchronous read for non-React callers (e.g. the command bar's capture handler). */
export function getVoiceInputSettings(): VoiceInputSettings {
  hydrateOnce();
  return state;
}

export function setVoiceInputSetting<K extends keyof VoiceInputSettings>(key: K, value: VoiceInputSettings[K]) {
  hydrateOnce();
  if (state[key] === value) return;
  state = { ...state, [key]: value };
  writeVoiceSetting(VOICE_INPUT_SLOT, JSON.stringify(state));
  emit();
}

/** Test-only: reset the shared store so suites don't leak state. */
export function resetVoiceInputStoreForTests() {
  state = DEFAULT_VOICE_INPUT;
  hydrated = false;
  listeners.clear();
}

export function useVoiceInputSettings(): VoiceInputSettings & {
  setAutoSubmit: (on: boolean) => void;
  setPolish: (on: boolean) => void;
  setAutoCleanup: (on: boolean) => void;
  setDictationMode: (mode: DictationModeId) => void;
  setSendRightAway: (on: boolean) => void;
} {
  const settings = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setAutoSubmit = useCallback((on: boolean) => setVoiceInputSetting("autoSubmit", on), []);
  const setPolish = useCallback((on: boolean) => setVoiceInputSetting("polish", on), []);
  const setAutoCleanup = useCallback((on: boolean) => setVoiceInputSetting("autoCleanup", on), []);
  const setDictationMode = useCallback((mode: DictationModeId) => setVoiceInputSetting("dictationMode", mode), []);
  const setSendRightAway = useCallback((on: boolean) => setVoiceInputSetting("sendRightAway", on), []);
  return { ...settings, setAutoSubmit, setPolish, setAutoCleanup, setDictationMode, setSendRightAway };
}
