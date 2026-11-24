"use client";
import type { ComponentProps } from "react";
import type { VoiceOutputSettings } from "@/lib/tauri-api";
import { VoiceOutputControls } from "../VoiceOutputControls";
import { VoiceProviderList } from "../VoiceProviderList";

interface Props {
  list: ComponentProps<typeof VoiceProviderList>;
  output: VoiceOutputSettings;
  onOutputChange: (next: VoiceOutputSettings) => void;
  speed?: number;
  onSpeedChange?: (speed: number | undefined) => void;
  disabled?: boolean;
}

/**
 * Speak, opened under its row: the text-to-speech engines (BYOK) and how the voice sounds (speak gate,
 * tone, speed) via {@link VoiceOutputControls}. Test is on the row; Reply length and agent alerts
 * live in Voice's behaviour groups.
 */
export function SpeakPanel({ list, output, onOutputChange, speed, onSpeedChange, disabled }: Props) {
  return (
    <>
      <VoiceProviderList {...list} />
      <VoiceOutputControls value={output} onChange={onOutputChange} speed={speed} onSpeedChange={onSpeedChange} disabled={disabled} />
    </>
  );
}
