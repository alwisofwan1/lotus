"use client";
import type { ComponentProps } from "react";
import { useVoiceInputSettings } from "@/modules/codecanvas/hooks/useVoiceInputSettings";
import { useCanvasHotkeyOverrides } from "@/modules/codecanvas/hooks/useCanvasHotkeySettings";
import {
  effectiveBindings,
  formatChord,
  UNBOUND_CHORD,
  type CanvasHotkeyPlatform,
} from "@/modules/codecanvas/services/canvas-hotkeys";
import { Kbd } from "@/components/ui/status";
import { SettingToggleRow } from "@/modules/lotus-settings/components/SettingToggleRow";
import { VoiceProviderList } from "../VoiceProviderList";

interface Props {
  list: ComponentProps<typeof VoiceProviderList>;
}

function detectPlatform(): CanvasHotkeyPlatform {
  if (typeof navigator === "undefined") return "mac";
  return /mac|iphone|ipad|ipod/i.test(navigator.platform) ? "mac" : "other";
}

function shortcutLabel(chord: string, platform: CanvasHotkeyPlatform): string {
  if (chord === UNBOUND_CHORD) return "Unassigned";
  return formatChord(chord, platform).join(platform === "mac" ? "" : "+");
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
  const platform = detectPlatform();

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
