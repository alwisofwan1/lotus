"use client";
import { useEffect, useState } from "react";
import { listChatModels, type ChatModel } from "@/modules/chat/runtime/chat-runtime-client";
import { SettingSegmentedRow } from "@/modules/lotus-settings/components/SettingSegmentedRow";
import { SettingSelectRow } from "@/modules/lotus-settings/components/SettingSelectRow";
import {
  updateAssistantSettings,
  useAssistantSettings,
  type AssistantBrain,
  type AssistantReadback,
} from "@/modules/voice-core/assistant/assistant-settings";
import type { ConfirmMode } from "@/modules/voice-core/risky-ask";

const BRAIN_OPTIONS: { value: AssistantBrain; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "claude", label: "Claude" },
];
const READBACK_OPTIONS: { value: AssistantReadback; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "short", label: "Short" },
  { value: "full", label: "Full" },
];
const DELEGATE_OPTIONS: { value: "claude" | "codex"; label: string }[] = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
];
const FALLBACK_EFFORTS = ["low", "medium", "high"];
const CONFIRM_OPTIONS: { value: ConfirmMode; label: string }[] = [
  { value: "always", label: "Always" },
  { value: "auto", label: "Risky only" },
  { value: "off", label: "Never" },
];
const CONFIRM_DESCRIPTIONS: Record<ConfirmMode, string> = {
  always: "Live Voice waits for your spoken yes before anything that changes something: edits, commits, commands, messages to agents.",
  auto: "Live Voice waits for your yes only when it is hard to undo or reaches other people: push, merge, delete, deploy, sending, pull requests. Edits and commits just go.",
  off: "Live Voice never waits for a yes. Agents still follow their own permission settings.",
};

/**
 * Voice › Live › Assistant brain (mockups/live-voice-assistant.html): which CLI Live Voice hands real
 * work to, and how much of its answer is spoken. The brain is a normal Chat thread, "Lotus Assistant".
 */
export function AssistantBrainSettings() {
  const settings = useAssistantSettings();
  const [models, setModels] = useState<ChatModel[]>([]);
  const runner = settings.brain === "off" ? null : settings.brain;

  useEffect(() => {
    if (!runner) return;
    let cancelled = false;
    listChatModels(runner)
      .then((list) => !cancelled && setModels(list))
      .catch(() => !cancelled && setModels([]));
    return () => {
      cancelled = true;
    };
  }, [runner]);

  const model = models.find((candidate) => candidate.value === settings.model);
  const efforts = model?.efforts?.length ? model.efforts : FALLBACK_EFFORTS;

  return (
    <>
      <SettingSegmentedRow
        title="Assistant brain"
        description="Live Voice hands questions and work to this agent. It runs in the background on your own subscription and stays out of the Chat list. Work it hands off shows up in Chat."
        options={BRAIN_OPTIONS}
        value={settings.brain}
        // A model of one runner means nothing to the other.
        onChange={(brain) => updateAssistantSettings(brain === settings.brain ? {} : { brain, model: "" })}
      />
      {runner && (
        <>
          <SettingSelectRow
            title="Model"
            selectLabel="Assistant model"
            options={[{ value: "", label: "Default" }, ...models.map((m) => ({ value: m.value, label: m.displayName }))]}
            value={settings.model}
            onChange={(next) => updateAssistantSettings({ model: next })}
          />
          <SettingSelectRow
            title="Effort"
            description="Low answers fastest."
            selectLabel="Assistant effort"
            options={[{ value: "", label: "Default" }, ...efforts.map((effort) => ({ value: effort, label: effort }))]}
            value={efforts.includes(settings.effort) ? settings.effort : ""}
            onChange={(next) => updateAssistantSettings({ effort: next })}
          />
          <SettingSegmentedRow
            title="Read results aloud"
            description="Off shows the answer only in the strip, and saves voice tokens. Questions before risky actions are always spoken."
            options={READBACK_OPTIONS}
            value={settings.readback}
            onChange={(readback) => updateAssistantSettings({ readback })}
          />
          <SettingSelectRow
            title="Agent for delegated work"
            selectLabel="Agent for delegated work"
            options={DELEGATE_OPTIONS}
            value={settings.delegateTo}
            onChange={(delegateTo) => updateAssistantSettings({ delegateTo })}
          />
        </>
      )}
      {/* Applies with the brain off too: Code and Canvas ask before a risky message to an agent. */}
      <SettingSegmentedRow
        title="Confirm actions"
        description={CONFIRM_DESCRIPTIONS[settings.confirm]}
        options={CONFIRM_OPTIONS}
        value={settings.confirm}
        onChange={(confirm) => updateAssistantSettings({ confirm })}
      />
    </>
  );
}
