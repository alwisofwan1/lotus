"use client";
// Per-device Voice settings state that is not engine config: whether first-time setup was finished
// or skipped, and each card's last Test result. Browser storage is enough — losing it only shows
// setup again or a card as "not tested", never a wrong setting.

import { useSyncExternalStore } from "react";
import { readVoiceSetting, writeVoiceSetting, VOICE_SETUP_SLOT, VOICE_TESTS_SLOT } from "@/modules/voice-core/voice-settings-storage";
import type { VoiceCapability, VoiceTestResult } from "./voice-health";

export type VoiceSetupState = "done" | "skipped" | null;
export type VoiceTests = Partial<Record<VoiceCapability, VoiceTestResult>>;

interface Snapshot {
  setup: VoiceSetupState;
  tests: VoiceTests;
}

const listeners = new Set<() => void>();
let snapshot: Snapshot | null = null;

function read(): Snapshot {
  const raw = readVoiceSetting(VOICE_SETUP_SLOT);
  const setup: VoiceSetupState = raw === "done" || raw === "skipped" ? raw : null;
  let tests: VoiceTests = {};
  try {
    const parsed = JSON.parse(readVoiceSetting(VOICE_TESTS_SLOT) ?? "{}");
    if (parsed && typeof parsed === "object") tests = parsed as VoiceTests;
  } catch {}
  return { setup, tests };
}

function get(): Snapshot {
  snapshot ??= read();
  return snapshot;
}

function set(next: Snapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

const EMPTY: Snapshot = { setup: null, tests: {} };

export function setVoiceSetupState(state: Exclude<VoiceSetupState, null>): void {
  writeVoiceSetting(VOICE_SETUP_SLOT, state);
  set({ ...get(), setup: state });
}

export function recordVoiceTest(capability: VoiceCapability, result: VoiceTestResult): void {
  const tests = { ...get().tests, [capability]: result };
  writeVoiceSetting(VOICE_TESTS_SLOT, JSON.stringify(tests));
  set({ ...get(), tests });
}

/** A saved key or a new engine makes an old failure meaningless; drop it so the light is honest. */
export function clearVoiceTest(capability: VoiceCapability): void {
  const tests = { ...get().tests };
  delete tests[capability];
  writeVoiceSetting(VOICE_TESTS_SLOT, JSON.stringify(tests));
  set({ ...get(), tests });
}

export function useVoiceSetupStore(): Snapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get,
    () => EMPTY,
  );
}

export function resetVoiceSetupStoreForTests(): void {
  snapshot = null;
}
