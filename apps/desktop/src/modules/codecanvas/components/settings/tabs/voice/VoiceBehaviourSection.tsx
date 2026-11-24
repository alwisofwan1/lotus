"use client";
import { Play } from "lucide-react";
import type { AgentDoneAlertMode, VoiceOutputSettings } from "@/lib/tauri-api";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { SettingRow } from "@/modules/lotus-settings/components/SettingsGroup";
import { SettingsSection } from "@/modules/lotus-settings/components/SettingsSection";
import { SettingToggleRow } from "@/modules/lotus-settings/components/SettingToggleRow";
import { SettingSegmentedRow } from "@/modules/lotus-settings/components/SettingSegmentedRow";
import { SettingSelectRow } from "@/modules/lotus-settings/components/SettingSelectRow";
import { useVoiceInputSettings } from "@/modules/codecanvas/hooks/useVoiceInputSettings";
import { agentDoneAlertMode, withAgentDoneAlert } from "@/modules/voice-core/agent-done-alert";
import { tauriVoicePort } from "@/modules/voice-core/tauri-voice-port";
import {
  AGENT_DONE_SOUNDS,
  agentDoneSoundId,
  agentDoneSoundSrc,
  createChimePlayer,
  type AgentDoneSoundId,
  type ChimePlayer,
} from "@/modules/voice-core/agent-done-chime";
import { CALLOUT_COOLDOWN_MS } from "@/modules/codecanvas/services/voice/callout-throttle";
import { useCanvasBehaviorSettings } from "@/modules/codecanvas/hooks/useCanvasBehaviorSettings";
import { VOICE_VERBOSITY_OPTIONS } from "../VoiceOutputControls";

const ALERT_OPTIONS: { value: AgentDoneAlertMode; label: string }[] = [
  { value: "voice", label: "Voice" },
  { value: "sound", label: "Sound" },
  { value: "off", label: "Off" },
];

/** Per-agent quiet time presets (ms). "Off" = alert on every turn. */
export const AGENT_DONE_QUIET_TIMES: { value: string; label: string }[] = [
  { value: "0", label: "Off — every turn" },
  { value: "15000", label: "15 seconds" },
  { value: "30000", label: "30 seconds" },
  { value: "45000", label: "45 seconds" },
  { value: "60000", label: "1 minute" },
  { value: "120000", label: "2 minutes" },
  { value: "300000", label: "5 minutes" },
];

const SOUND_OPTIONS = AGENT_DONE_SOUNDS.map((s) => ({ value: s.id as AgentDoneSoundId, label: s.label }));

// One element for every preview (a fresh one per click lingers as a WebKit media session). No batch
// window: a preview must play on every click, unlike a burst of finishing agents.
let previewPlayer: ChimePlayer | null = null;
function previewSound(id: string) {
  previewPlayer ??= createChimePlayer({ batchMs: 0, playNative: tauriVoicePort.playAgentDoneSound });
  previewPlayer.play(agentDoneSoundSrc(id));
}

interface Props {
  /** The TTS registry's `output` block; the agent-finish rows read and write it. */
  output: VoiceOutputSettings;
  onOutputChange: (next: VoiceOutputSettings) => void;
  disabled?: boolean;
}

/**
 * Voice's behaviour groups (mockups/settings-voice.html): Dictation, When an agent finishes, and
 * Spoken replies — the preferences that shape a turn rather than an engine, whichever mode uses it.
 */
export function VoiceBehaviourSection({ output, onOutputChange, disabled }: Props) {
  const { sendRightAway, setSendRightAway, autoCleanup, setAutoCleanup } = useVoiceInputSettings();
  const mode = agentDoneAlertMode(output);
  const set = (patch: Partial<VoiceOutputSettings>) => onOutputChange({ ...output, ...patch });
  const { liveNarration, setBehavior } = useCanvasBehaviorSettings();
  return (
    <>
      <SettingsSection label="Dictation">
        <SettingToggleRow
          title="Send right away"
          description="Send when you stop talking. Off: review it, then press Enter."
          checked={sendRightAway}
          onChange={setSendRightAway}
        />
        <SettingToggleRow
          title="Clean up dictation"
          description="Fix punctuation and filler words in the language you spoke; meaning is kept."
          checked={autoCleanup}
          onChange={setAutoCleanup}
        />
      </SettingsSection>
      <SettingsSection label="When an agent finishes">
        <SettingSegmentedRow
          title="Alert"
          description="Says the agent's name, or plays a chime. Quiet during Live."
          options={ALERT_OPTIONS}
          value={mode}
          onChange={(next) => onOutputChange(withAgentDoneAlert(output, next))}
          disabled={disabled}
        />
        {mode !== "off" ? (
          <>
            <SettingRow
              label="Sound"
              description={mode === "sound" ? "Plays when an agent finishes." : "Plays when Voice has nothing to speak with."}
            >
              <Select
                label="Sound"
                options={SOUND_OPTIONS}
                value={agentDoneSoundId(output.agentDoneSound)}
                onChange={(agentDoneSound) => {
                  set({ agentDoneSound });
                  previewSound(agentDoneSound);
                }}
                disabled={disabled}
              />
              <Button icon aria-label="Preview sound" onClick={() => previewSound(output.agentDoneSound ?? "classic")} disabled={disabled}>
                <Play size={13} />
              </Button>
            </SettingRow>
            <SettingToggleRow
              title="Also when on screen"
              description="Off: only agents you can't see."
              checked={output.wakeOnFinish}
              onChange={(wakeOnFinish) => set({ wakeOnFinish })}
              disabled={disabled}
            />
            <SettingSelectRow
              title="Quiet time per agent"
              description="No repeat alert unless you sent it something new."
              selectLabel="Quiet time per agent"
              options={AGENT_DONE_QUIET_TIMES}
              value={String(output.agentDoneCooldownMs ?? CALLOUT_COOLDOWN_MS)}
              onChange={(value) => set({ agentDoneCooldownMs: Number(value) })}
              disabled={disabled}
            />
          </>
        ) : null}
      </SettingsSection>
      <SettingsSection label="Spoken replies">
        <SettingSelectRow
          title="Reply length"
          description="Brief is one breath; Expressive adds evidence and next steps."
          selectLabel="Reply length"
          options={VOICE_VERBOSITY_OPTIONS}
          value={output.verbosity ?? "normal"}
          onChange={(verbosity) => set({ verbosity })}
          disabled={disabled}
        />
        <SettingToggleRow
          title="Narrate agent work aloud"
          description="Speak edits, searches and failures as they happen."
          checked={liveNarration}
          onChange={(v) => setBehavior("liveNarration", v)}
        />
      </SettingsSection>
    </>
  );
}
