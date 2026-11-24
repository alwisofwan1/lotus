export type VoiceTurnRoute = "command" | "dictate" | "transform" | "insert" | "empty";
export type VoiceTurnFidelity = "accepted" | "rejected" | "not-run";
export type VoiceTurnDelivery = "written" | "queued" | "failed";
export type VoiceCaptureQuality = "unknown" | "speech-like" | "low-speech";
export type VoiceLanguageIntegrity = "unknown" | "match" | "mismatch";

export interface VoiceTurnLatency {
  capture?: number;
  transcription?: number;
  replacements?: number;
  polish?: number;
  /** Native-confirmed PTY Enter to the first correlated agent output. */
  agentFirstOutput?: number;
  total: number;
}

export type VoiceTurnMilestoneName =
  | "mic_stop"
  | "audio_upload_drained"
  | "stt_final"
  | "route_resolved"
  | "polish_started"
  | "polish_finished"
  | "delivery_requested"
  | "delivery_accepted"
  | "typed_for_review"
  | "pty_paste_written"
  | "pty_enter_written"
  | "agent_first_output"
  | "command_submitted"
  | "transform_finished"
  | "held_for_review"
  | "turn_complete";

/** Transcript-free timing relative to mic stop; safe for the support projection. */
export interface VoiceTurnMilestone {
  name: VoiceTurnMilestoneName;
  elapsedMs: number;
}

export interface VoiceTurnDiagnosticInput {
  /** Local-only correlation id. Never included in support projections. */
  turnId?: string;
  provider: string;
  model?: string;
  requestedLanguages: readonly string[];
  detectedLanguages: readonly string[];
  rawTranscript: string;
  replacementTranscript?: string;
  polishedTranscript?: string;
  finalTranscript: string;
  route: VoiceTurnRoute;
  captureQuality?: VoiceCaptureQuality;
  spectrumFrames?: number;
  peakSpectrumLevel?: number;
  languageIntegrity?: VoiceLanguageIntegrity;
  latencyMs: VoiceTurnLatency;
  milestones?: readonly VoiceTurnMilestone[];
  delivery?: VoiceTurnDelivery;
  fidelity?: VoiceTurnFidelity;
}

export interface VoiceTurnDiagnostic extends VoiceTurnDiagnosticInput {
  ordinal: number;
  recordedAt: number;
}

export interface VoiceTurnSupportEntry {
  ordinal: number;
  recordedAt: number;
  provider: string;
  model?: string;
  requestedLanguageCount: number;
  detectedLanguageCount: number;
  route: VoiceTurnRoute;
  captureQuality: VoiceCaptureQuality;
  spectrumFrames?: number;
  peakSpectrumLevel?: number;
  languageIntegrity: VoiceLanguageIntegrity;
  fidelity: VoiceTurnFidelity;
  latencyMs: VoiceTurnLatency;
  milestones: VoiceTurnMilestone[];
}

export interface VoiceTurnSupportSnapshot {
  version: 1;
  turns: VoiceTurnSupportEntry[];
}

const MAX_TURNS = 20;
let nextOrdinal = 1;
let nextTurnSequence = 1;
let turns: VoiceTurnDiagnostic[] = [];

/** Create a process-local id without exposing transcript, pane, agent, or project identity. */
export function createVoiceTurnId(now: () => number = Date.now): string {
  const id = `classic-${now().toString(36)}-${nextTurnSequence.toString(36)}`;
  nextTurnSequence += 1;
  return id;
}

function cloneMilestones(milestones: readonly VoiceTurnMilestone[] | undefined): VoiceTurnMilestone[] {
  return (milestones ?? []).map((milestone) => ({ ...milestone }));
}

/** Record local-only detailed QA data. This module never persists across an app restart. */
export function recordVoiceTurnDiagnostic(input: VoiceTurnDiagnosticInput, now = Date.now()): void {
  // TEMP DIAG (dictation truncation): remove after one live round.
  const diagLine = `[stt-diag] turn route=${input.route} raw="${input.rawTranscript}" replaced="${input.replacementTranscript ?? ""}" polished="${input.polishedTranscript ?? ""}" final="${input.finalTranscript}" delivery=${input.delivery ?? ""}`;
  console.info(diagLine);
  void import("@/lib/tauri-api").then((m) => m.s2sDebugLog?.(diagLine)).catch(() => {});
  turns.push({
    ...input,
    ordinal: nextOrdinal,
    recordedAt: now,
    requestedLanguages: [...input.requestedLanguages],
    detectedLanguages: [...input.detectedLanguages],
    latencyMs: { ...input.latencyMs },
    milestones: cloneMilestones(input.milestones),
  });
  nextOrdinal += 1;
  if (turns.length > MAX_TURNS) turns = turns.slice(-MAX_TURNS);
}

export interface VoiceTurnDiagnosticUpdate {
  latencyMs: VoiceTurnLatency;
  milestones: readonly VoiceTurnMilestone[];
}

/** Patch a previously recorded local turn when asynchronous PTY/agent milestones arrive. */
export function updateVoiceTurnDiagnostic(
  turnId: string,
  update: VoiceTurnDiagnosticUpdate,
): boolean {
  const index = turns.findLastIndex((turn) => turn.turnId === turnId);
  if (index < 0) return false;
  turns[index] = {
    ...turns[index],
    latencyMs: { ...update.latencyMs },
    milestones: cloneMilestones(update.milestones),
  };
  return true;
}

export function getVoiceTurnDiagnostics(): VoiceTurnDiagnostic[] {
  return turns.map((turn) => ({
    ...turn,
    requestedLanguages: [...turn.requestedLanguages],
    detectedLanguages: [...turn.detectedLanguages],
    latencyMs: { ...turn.latencyMs },
    milestones: cloneMilestones(turn.milestones),
  }));
}

/** Support-safe projection: transcript/audio/context vocabulary do not exist in this return type. */
export function getVoiceTurnSupportSnapshot(): VoiceTurnSupportSnapshot {
  return {
    version: 1,
    turns: turns.map((turn) => ({
      ordinal: turn.ordinal,
      recordedAt: turn.recordedAt,
      provider: turn.provider,
      model: turn.model,
      requestedLanguageCount: turn.requestedLanguages.length,
      detectedLanguageCount: turn.detectedLanguages.length,
      route: turn.route,
      captureQuality: turn.captureQuality ?? "unknown",
      ...(typeof turn.spectrumFrames === "number" ? { spectrumFrames: turn.spectrumFrames } : {}),
      ...(typeof turn.peakSpectrumLevel === "number" ? { peakSpectrumLevel: turn.peakSpectrumLevel } : {}),
      languageIntegrity: turn.languageIntegrity ?? "unknown",
      fidelity: turn.fidelity ?? "not-run",
      latencyMs: { ...turn.latencyMs },
      milestones: cloneMilestones(turn.milestones),
    })),
  };
}

export function clearVoiceTurnDiagnostics(): void {
  turns = [];
  nextOrdinal = 1;
}
