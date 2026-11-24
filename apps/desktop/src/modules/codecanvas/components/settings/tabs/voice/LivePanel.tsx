"use client";
import type { ComponentProps } from "react";
import { SettingRow } from "@/modules/lotus-settings/components/SettingsGroup";
import { VoiceProviderList } from "../VoiceProviderList";

interface Props {
  list: ComponentProps<typeof VoiceProviderList>;
}

/**
 * Live, opened under its row: experimental hands-free voice-to-voice (S2S). Opt-in: off unless a
 * provider is enabled and set active. The turn-based Listen/Speak loop is unaffected by anything here.
 */
export function LivePanel({ list }: Props) {
  return (
    <>
      <SettingRow
        label="Live voice"
        description="Beta. You talk, it talks back in realtime and can hand work to your agents. Billed per minute on your key."
      />
      <VoiceProviderList {...list} />
    </>
  );
}
