import type { AgentDoneAlertMode, VoiceOutputSettings } from "@/lib/tauri-api";

/**
 * **Agent-Done Alert** (plans/voice-core story 28, Lotus #184): how a finished agent turn is announced,
 * one setting for Canvas and Code. "voice" speaks the agent's name through the Speaker Queue, "sound"
 * plays a chime, "off" stays silent. Pure — the turn-end signals and the playing are wired elsewhere.
 */

export const AGENT_DONE_ALERT_MODES: readonly AgentDoneAlertMode[] = ["voice", "sound", "off"];

/** The effective mode. With no choice saved, an enabled switch means "sound" — the default since 2026-11-24, also for older files. */
export function agentDoneAlertMode(settings: VoiceOutputSettings | undefined): AgentDoneAlertMode {
  if (!settings) return "off";
  const mode = settings.agentDoneAlert;
  if (mode && AGENT_DONE_ALERT_MODES.includes(mode)) return mode;
  return settings.agentDoneCallouts ? "sound" : "off";
}

/** Settings with a new mode. The old switch follows it, so an older build reading the file agrees. */
export function withAgentDoneAlert(settings: VoiceOutputSettings, mode: AgentDoneAlertMode): VoiceOutputSettings {
  return { ...settings, agentDoneAlert: mode, agentDoneCallouts: mode !== "off" };
}

/** Whether anything plays at all — the turn-end watchers can stay idle when it does not. */
export function agentDoneAlertsEnabled(settings: VoiceOutputSettings | undefined): boolean {
  return agentDoneAlertMode(settings) !== "off";
}

/**
 * Whether this finish is announced. One the user cannot see (off-canvas, a pane not in front, the app
 * in the background) always is; one they are looking at only with "Also when on screen" (`wakeOnFinish`).
 */
export function shouldAlertAgentFinish(visible: boolean, settings: VoiceOutputSettings): boolean {
  if (!agentDoneAlertsEnabled(settings)) return false;
  return visible ? settings.wakeOnFinish : true;
}

/** What actually plays: voice falls back to the chime when there is nothing to speak with. */
export function agentDoneAlertKind(settings: VoiceOutputSettings, canSpeak: boolean): "voice" | "sound" | null {
  const mode = agentDoneAlertMode(settings);
  if (mode === "off") return null;
  if (mode === "voice" && canSpeak) return "voice";
  return "sound";
}
