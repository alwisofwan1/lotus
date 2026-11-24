"use client";
import { useCallback, useSyncExternalStore } from "react";
import { readVoiceSetting, VOICE_ACCURACY_SLOT, writeVoiceSetting } from "@/modules/voice-core/voice-settings-storage";
import type { VoiceReplacementRule, VoiceReplacementTiming } from "../services/voice/voice-replacements";

export interface VoiceAccuracySettings {
  personalTerms: string[];
  expectedLanguages: string[];
  replacements: VoiceReplacementRule[];
}

// Stored under the app-level voice key; the old canvas key is carried over once (Voice Core).
const EMPTY_SETTINGS: VoiceAccuracySettings = { personalTerms: [], expectedLanguages: [], replacements: [] };
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z]{2}|-\d{3})?$/;
const TIMINGS = new Set<VoiceReplacementTiming>(["before-ai", "after-ai", "both"]);
let state = EMPTY_SETTINGS;
let hydrated = false;
const listeners = new Set<() => void>();

function normalizeList(values: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const clean = value.normalize("NFKC").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
    if (!clean || clean.length > maxChars) continue;
    const key = clean.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeSettings(value: unknown): VoiceAccuracySettings {
  const raw = value && typeof value === "object" ? value as Partial<VoiceAccuracySettings> : {};
  const personalTerms = normalizeList(raw.personalTerms, 128, 64);
  const expectedLanguages = normalizeList(raw.expectedLanguages, 4, 16).filter((language) => LANGUAGE.test(language));
  const replacements = Array.isArray(raw.replacements)
    ? raw.replacements.slice(0, 256).flatMap((value): VoiceReplacementRule[] => {
        if (!value || typeof value !== "object") return [];
        const rule = value as Partial<VoiceReplacementRule>;
        const variants = normalizeList(rule.variants, 16, 128);
        const replacement = typeof rule.replacement === "string" ? rule.replacement.normalize("NFKC").trim() : "";
        if (
          typeof rule.id !== "string" || !rule.id.trim() || variants.length === 0 ||
          !replacement || replacement.length > 256 || !TIMINGS.has(rule.timing as VoiceReplacementTiming)
        ) return [];
        return [{
          id: rule.id.trim().slice(0, 64),
          variants,
          replacement,
          timing: rule.timing as VoiceReplacementTiming,
          enabled: rule.enabled !== false,
        }];
      })
    : [];
  return { personalTerms, expectedLanguages, replacements };
}

function load(): VoiceAccuracySettings {
  try {
    const raw = readVoiceSetting(VOICE_ACCURACY_SLOT);
    return raw ? normalizeSettings(JSON.parse(raw)) : EMPTY_SETTINGS;
  } catch {
    return EMPTY_SETTINGS;
  }
}

function hydrateOnce() {
  if (hydrated) return;
  hydrated = true;
  state = load();
}

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getVoiceAccuracySettings(): VoiceAccuracySettings {
  hydrateOnce();
  return state;
}

export function setVoiceAccuracySettings(value: VoiceAccuracySettings): void {
  hydrateOnce();
  state = normalizeSettings(value);
  writeVoiceSetting(VOICE_ACCURACY_SLOT, JSON.stringify(state));
  emit();
}

export function useVoiceAccuracySettings(): VoiceAccuracySettings & {
  setSettings: (value: VoiceAccuracySettings) => void;
} {
  hydrateOnce();
  const settings = useSyncExternalStore(subscribe, () => state, () => EMPTY_SETTINGS);
  const setSettings = useCallback((value: VoiceAccuracySettings) => setVoiceAccuracySettings(value), []);
  return { ...settings, setSettings };
}

export function resetVoiceAccuracyStoreForTests(): void {
  state = EMPTY_SETTINGS;
  hydrated = false;
  listeners.clear();
}
