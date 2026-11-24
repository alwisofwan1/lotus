/**
 * Where app-level voice settings live in browser storage. Every voice setting has a mode-neutral key;
 * the ones that started in canvas also name their old `canvas-voice-*` key. The first read copies the
 * old value over once, and after that the old key is never read again (story 47).
 */
export interface VoiceSettingsSlot {
  /** The mode-neutral key every mode reads and writes. */
  key: string;
  /** The canvas-era key whose value is carried over once. */
  legacyKey?: string;
}

export const VOICE_INPUT_SLOT: VoiceSettingsSlot = { key: "lotus-voice-input-v1", legacyKey: "canvas-voice-input-v1" };
export const VOICE_ACCURACY_SLOT: VoiceSettingsSlot = { key: "lotus-voice-accuracy-v1", legacyKey: "canvas-voice-accuracy-v1" };
export const VOICE_HOTKEYS_SLOT: VoiceSettingsSlot = { key: "lotus-voice-hotkeys-v1" };
/** Voice › first-time setup: "done" or "skipped" once the user finished or left it. */
export const VOICE_SETUP_SLOT: VoiceSettingsSlot = { key: "lotus-voice-setup-v1" };
/** The last Test result per Voice card, so a status light survives reopening Settings. */
export const VOICE_TESTS_SLOT: VoiceSettingsSlot = { key: "lotus-voice-tests-v1" };

/** The stored raw value of a slot, or null. Storage that throws reads as empty. */
export function readVoiceSetting(slot: VoiceSettingsSlot): string | null {
  try {
    const current = localStorage.getItem(slot.key);
    if (current !== null || !slot.legacyKey) return current;
    const legacy = localStorage.getItem(slot.legacyKey);
    if (legacy !== null) localStorage.setItem(slot.key, legacy);
    return legacy;
  } catch {
    return null;
  }
}

export function writeVoiceSetting(slot: VoiceSettingsSlot, value: string): void {
  try {
    localStorage.setItem(slot.key, value);
  } catch {}
}
