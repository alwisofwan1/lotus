"use client";
// Voice › Live › Assistant brain (mockups/live-voice-assistant.html). Per-device, in browser storage
// like the other voice settings: losing it only turns the brain off, never runs anything.

import { useSyncExternalStore } from "react";
import type { ConfirmMode } from "@/modules/voice-core/risky-ask";
import { readVoiceSetting, writeVoiceSetting, type VoiceSettingsSlot } from "@/modules/voice-core/voice-settings-storage";

/**
 * Which CLI thinks behind Live Voice. "off" = Live Voice keeps only its own tools. Claude only: Codex
 * runs whatever `~/.codex/rules` allows without asking, so it cannot promise the spoken "yes" first.
 */
export type AssistantBrain = "off" | "claude";
/** How much of the brain's answer Live Voice speaks. "off" shows it in the strip and the chat only. */
export type AssistantReadback = "off" | "short" | "full";

export interface AssistantSettings {
  brain: AssistantBrain;
  /** Model id for the brain's runner; "" = that runner's default. */
  model: string;
  /** Reasoning effort; "" = the model's default. */
  effort: string;
  readback: AssistantReadback;
  /** When Live Voice waits for the spoken "yes" — the brain, and messages to agents in Code and Canvas. */
  confirm: ConfirmMode;
  /** Which agent the brain hands implementation work to. */
  delegateTo: "claude" | "codex";
}

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = {
  brain: "off",
  model: "",
  effort: "low",
  readback: "off",
  confirm: "auto",
  delegateTo: "claude",
};

export const VOICE_ASSISTANT_SLOT: VoiceSettingsSlot = { key: "lotus-voice-assistant-v1" };

const BRAINS: readonly AssistantBrain[] = ["off", "claude"];
const READBACKS: readonly AssistantReadback[] = ["off", "short", "full"];
const CONFIRM_MODES: readonly ConfirmMode[] = ["always", "auto", "off"];

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Whatever is stored, as valid settings: unknown or broken values fall back one field at a time. */
export function parseAssistantSettings(raw: string | null): AssistantSettings {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
  } catch {}
  const d = DEFAULT_ASSISTANT_SETTINGS;
  return {
    // A Codex brain saved before Codex was withdrawn keeps the user's "on", now on Claude.
    brain: stored.brain === "codex" ? "claude" : pick(stored.brain, BRAINS, d.brain),
    model: typeof stored.model === "string" ? stored.model.trim() : d.model,
    effort: typeof stored.effort === "string" ? stored.effort.trim() : d.effort,
    readback: pick(stored.readback, READBACKS, d.readback),
    // The earlier on/off switch: off keeps meaning never ask.
    confirm: stored.askBeforeRisky === false && stored.confirm === undefined ? "off" : pick(stored.confirm, CONFIRM_MODES, d.confirm),
    delegateTo: pick(stored.delegateTo, ["claude", "codex"] as const, d.delegateTo),
  };
}

const listeners = new Set<() => void>();
let snapshot: AssistantSettings | null = null;

/** The current settings, outside React (the brain reads them on every ask). */
export function getAssistantSettings(): AssistantSettings {
  snapshot ??= parseAssistantSettings(readVoiceSetting(VOICE_ASSISTANT_SLOT));
  return snapshot;
}

export function updateAssistantSettings(patch: Partial<AssistantSettings>): void {
  snapshot = { ...getAssistantSettings(), ...patch };
  writeVoiceSetting(VOICE_ASSISTANT_SLOT, JSON.stringify(snapshot));
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAssistantSettings(): AssistantSettings {
  return useSyncExternalStore(subscribe, getAssistantSettings, () => DEFAULT_ASSISTANT_SETTINGS);
}
