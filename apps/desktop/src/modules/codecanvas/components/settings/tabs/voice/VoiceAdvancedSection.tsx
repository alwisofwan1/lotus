"use client";
import { ChevronRight, RotateCcw, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingRow } from "@/modules/lotus-settings/components/SettingsGroup";
import { useVoiceInputSettings } from "@/modules/codecanvas/hooks/useVoiceInputSettings";
import { DICTATION_MODES } from "@/modules/codecanvas/services/voice/dictation-mode";
import { useCanvasBehaviorSettings } from "@/modules/codecanvas/hooks/useCanvasBehaviorSettings";
import { SettingToggleRow } from "@/modules/lotus-settings/components/SettingToggleRow";
import { SettingSegmentedRow } from "@/modules/lotus-settings/components/SettingSegmentedRow";
import { VoiceAccuracyControls } from "./VoiceAccuracyControls";

interface Props {
  onReload: () => void;
  onRerunSetup: () => void;
  /** Open on first render (tests, deep links). */
  defaultOpen?: boolean;
}

const POLISH_OPTIONS = Object.values(DICTATION_MODES).map((mode) => ({ value: mode.id, label: mode.label }));

/**
 * Voice › Advanced (mockups/settings-voice.html, 03): what most people never touch — recognition
 * accuracy, text polish, Live auto-close, where keys live, Reload and Rerun setup. Collapsed by default.
 */
export function VoiceAdvancedSection({ onReload, onRerunSetup, defaultOpen = false }: Props) {
  const { polish, autoCleanup, dictationMode, setPolish, setDictationMode } = useVoiceInputSettings();
  const { voiceAutoCloseAfterCommand, setBehavior } = useCanvasBehaviorSettings();
  const mode = DICTATION_MODES[dictationMode];
  return (
    <details className="ui-disclosure" open={defaultOpen}>
      <summary>
        <ChevronRight size={12} aria-hidden />
        Advanced
      </summary>
      <div className="ui-group-card">
        <VoiceAccuracyControls />
        <SettingToggleRow
          title="Show text polish action"
          description="Adds Polish text to the Canvas command bar, for typed text too."
          checked={polish}
          onChange={setPolish}
        />
        {(polish || autoCleanup) && (
          <SettingSegmentedRow
            title="Polish style"
            description={mode?.description}
            options={POLISH_OPTIONS}
            value={dictationMode}
            onChange={setDictationMode}
          />
        )}
        <SettingToggleRow
          title="Live voice: auto-close after each command"
          description="End the Live session once a command completes and you fall silent."
          checked={voiceAutoCloseAfterCommand}
          onChange={(v) => setBehavior("voiceAutoCloseAfterCommand", v)}
        />
        <SettingRow label="Keys" description={<>Stored in ~/.lotus/{"{stt,tts,s2s}"}-providers.json, never uploaded.</>}>
          <Button size="sm" onClick={onReload}>
            <RotateCcw size={13} aria-hidden="true" /> Reload
          </Button>
          <Button size="sm" onClick={onRerunSetup}>
            <Wand2 size={13} aria-hidden="true" /> Rerun setup
          </Button>
        </SettingRow>
      </div>
    </details>
  );
}
