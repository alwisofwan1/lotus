"use client";
import { useState } from "react";
import type { VoiceOutputSettings, VoiceTone, VoiceVerbosity } from "@/lib/tauri-api";
import { SettingSelectRow } from "@/modules/lotus-settings/components/SettingSelectRow";
import { SettingToggleRow } from "@/modules/lotus-settings/components/SettingToggleRow";

interface Props {
  value: VoiceOutputSettings;
  onChange: (next: VoiceOutputSettings) => void;
  /** Active TTS provider's playback speed (TtsProviderConfig.speed); undefined = provider default. */
  speed?: number;
  /** Persists a new speed on the ACTIVE provider (undefined clears back to default). */
  onSpeedChange?: (speed: number | undefined) => void;
  disabled?: boolean;
}

const TONES: { value: VoiceTone; label: string }[] = [
  { value: "jarvis", label: "Jarvis (poised valet)" },
  { value: "warm", label: "Warm & casual" },
  { value: "formal", label: "Formal" },
  { value: "brisk", label: "Brisk" },
  { value: "custom", label: "Custom…" },
];

export const VOICE_VERBOSITY_OPTIONS: { value: VoiceVerbosity; label: string }[] = [
  { value: "brief", label: "Brief" },
  { value: "normal", label: "Normal" },
  { value: "expressive", label: "Expressive" },
];

/** Curated playback speeds — a select commits once per change (no slider write-storms). */
const SPEEDS = ["0.8", "0.9", "1", "1.1", "1.25", "1.5"] as const;

/**
 * Voice OUTPUT controls (ADR-0031): the master speak gate and the voice personality — tone preset
 * (+ custom instructions) and playback speed. Reply length lives in Voice › How voice behaves. When a finished agent is
 * announced lives in Voice › How voice behaves (`VoiceBehaviourSection`).
 * Pure/presentational — persistence is the caller's job.
 */
export function VoiceOutputControls({ value, onChange, speed, onSpeedChange, disabled }: Props) {
  const set = (patch: Partial<VoiceOutputSettings>) => onChange({ ...value, ...patch });
  // Draft-then-commit for the custom instructions: one settings write per edit, not per keystroke.
  // Saved-value changes re-seed the draft via the render-time adjust pattern (no effect cascade).
  const saved = value.toneInstructions ?? "";
  const [instructionsDraft, setInstructionsDraft] = useState(saved);
  const [seededFrom, setSeededFrom] = useState(saved);
  if (saved !== seededFrom) {
    setSeededFrom(saved);
    setInstructionsDraft(saved);
  }
  return (
    <>
        <SettingToggleRow
          title="Speak replies"
          description="Read confirmations aloud after each command."
          checked={value.speakReplies}
          disabled={disabled}
          onChange={(speakReplies) => set({ speakReplies })}
        />
        <SettingSelectRow
          title="Tone"
          description="Shapes the wording, and the delivery on cloud voices."
          selectLabel="Voice tone"
          options={TONES}
          value={value.tone ?? "jarvis"}
          onChange={(tone) => set({ tone })}
          disabled={disabled}
          footer={
            (value.tone ?? "jarvis") === "custom" ? (
              <textarea
                aria-label="Custom tone instructions"
                value={instructionsDraft}
                onChange={(e) => setInstructionsDraft(e.target.value)}
                onBlur={() => set({ toneInstructions: instructionsDraft })}
                placeholder='e.g. "Bicara santai seperti teman dekat, jangan kaku."'
                rows={2}
                disabled={disabled}
                className="ui-field w-full resize-none"
              />
            ) : null
          }
        />
        {onSpeedChange && (
          <SettingSelectRow
            title="Speech speed"
            description="Playback rate of the active voice."
            selectLabel="Speech speed"
            options={[
              { value: "default", label: "Default" },
              ...SPEEDS.map((s) => ({ value: s, label: `${s}×` })),
            ]}
            value={speed !== undefined ? String(speed) : "default"}
            onChange={(v) => onSpeedChange(v === "default" ? undefined : Number(v))}
            disabled={disabled}
          />
        )}
    </>
  );
}
