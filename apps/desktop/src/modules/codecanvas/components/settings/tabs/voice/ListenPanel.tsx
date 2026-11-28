"use client";
import type { ComponentProps } from "react";
import { useVoiceInputSettings } from "@/modules/codecanvas/hooks/useVoiceInputSettings";
import { useCanvasHotkeyOverrides } from "@/modules/codecanvas/hooks/useCanvasHotkeySettings";
import { detectCanvasHotkeyPlatform, effectiveBindings } from "@/modules/codecanvas/services/canvas-hotkeys";
import { Kbd } from "@/components/ui/status";
import { SettingToggleRow } from "@/modules/lotus-settings/components/SettingToggleRow";
import { VoiceProviderList } from "../VoiceProviderList";
import { shortcutLabel } from "./voice-shortcuts";

interface Props {
  list: ComponentProps<typeof VoiceProviderList>;
}

/**
 * Listen, opened under its row: the speech-to-text engines (BYOK) and the input behaviour they govern,
 * Auto mode and auto-run. Send Right Away lives in Voice › Dictation (ADR-0064); accuracy and polish
 * style in Voice › Advanced. State is the device-level `useVoiceInputSettings` store (unchanged).
 */
export function ListenPanel({ list }: Props) {
  const { autoSubmit, setAutoSubmit } = useVoiceInputSettings();
  const { overrides } = useCanvasHotkeyOverrides();
  const bindings = effectiveBindings(overrides);
  const platform = detectCanvasHotkeyPlatform();

  return (
    <>
      <VoiceProviderList {...list} />
      <SettingToggleRow
        title="Auto-run commands"
        description={
          <>
            Mic picks command or dictation from focus; force with <Kbd keys={[shortcutLabel(bindings["voice-command"], platform)]} /> or{" "}
            <Kbd keys={[shortcutLabel(bindings["voice-dictate"], platform)]} />. On: a spoken command runs when you stop.
          </>
        }
        checked={autoSubmit}
        onChange={setAutoSubmit}
      />
    </>
  );
}
