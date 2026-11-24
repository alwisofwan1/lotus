"use client";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useTtsProviderRegistry } from "@/lib/hooks/useTtsProviderRegistry";
import { useSttProviderRegistry } from "@/lib/hooks/useSttProviderRegistry";
import { useVoiceFeedback } from "@/modules/voice-core/use-voice-feedback";
import { agentDoneAlertKind, shouldAlertAgentFinish } from "@/modules/voice-core/agent-done-alert";
import { buildFinishCallout } from "@/modules/codecanvas/services/voice/agent-done-callout";
import { CALLOUT_COOLDOWN_MS, createCalloutThrottle } from "@/modules/codecanvas/services/voice/callout-throttle";
import { bundledPersonaSource, loadPersona, personaNameForTone } from "@/modules/codecanvas/services/voice/persona/canvas-persona";

export interface CodeAgentDoneAlertsInput {
  /** The pane's display name ("Rani"), read when its turn ends. */
  nameFor: (paneId: string) => string | undefined;
}

/**
 * Agent-Done Alerts in Code mode (plans/voice-core story 28, Lotus #184). Returns the listener for
 * `usePaneUnread`'s turn ends — the same Turn-Done decision that lights "Done · new", so a process
 * exiting never counts. The setting, the quiet time per agent and the phrasing are Canvas's: one
 * Voice › How voice behaves setting for both. Voice goes through the shared Speaker Queue (held and
 * summed up while Live Voice is on); Sound is one batched chime, skipped while Live Voice is on.
 */
export function useCodeAgentDoneAlerts({ nameFor }: CodeAgentDoneAlertsInput) {
  const voice = useVoiceFeedback();
  const { registry } = useTtsProviderRegistry();
  const { registry: sttRegistry } = useSttProviderRegistry();
  const language = sttRegistry?.providers.find((p) => p.id === sttRegistry.activeProvider)?.language;
  const [throttle] = useState(createCalloutThrottle);
  const counterRef = useRef(0);

  const latest = useRef({ output: registry?.output, language, nameFor, voice });
  useLayoutEffect(() => {
    latest.current = { output: registry?.output, language, nameFor, voice };
  });

  return useCallback(
    (paneId: string, { seen, fresh }: { seen: boolean; fresh: boolean }) => {
      const { output, language: lang, nameFor: name, voice: speaker } = latest.current;
      if (!output || !shouldAlertAgentFinish(seen, output)) return;
      if (!throttle.tryEmit(paneId, Date.now(), fresh, output.agentDoneCooldownMs ?? CALLOUT_COOLDOWN_MS)) return;
      const kind = agentDoneAlertKind(output, speaker.canSpeak());
      if (kind === "sound") {
        speaker.chime();
        return;
      }
      const agent = name(paneId) ?? "";
      const pools = loadPersona(personaNameForTone(output.tone), [bundledPersonaSource()]).callouts;
      const line = buildFinishCallout(agent, lang, counterRef.current, undefined, pools);
      counterRef.current += 1;
      void speaker.announce(line, { language: lang, priority: "callout", name: agent || undefined });
    },
    [throttle],
  );
}
