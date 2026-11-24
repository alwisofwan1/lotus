import type { S2sToolCall } from "./s2s-stream-bridge";

export interface S2sVoiceDialogueState {
  lastTargetName?: string;
}

const PRONOUN_TARGETS = new Set(["him", "her", "them", "it", "that", "that one", "there", "dia", "itu", "sana"]);

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolvedFromSummary(summary: string | undefined): string | undefined {
  return summary?.match(/^(?:Dispatch to|Say to|Focus)\s+(.+)$/i)?.[1]?.trim();
}

export function applyS2sVoiceDialogueMemory(call: S2sToolCall, state: S2sVoiceDialogueState): S2sToolCall {
  const target = str(call.args.target);
  if (!target || !state.lastTargetName || !PRONOUN_TARGETS.has(target.toLowerCase())) return call;
  return { ...call, args: { ...call.args, target: state.lastTargetName } };
}

export function recordS2sVoiceDialogueTurn(state: S2sVoiceDialogueState, result: unknown): S2sVoiceDialogueState {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  if (record.ok === false) return state;
  const target = resolvedFromSummary(str(record.summary));
  return target ? { ...state, lastTargetName: target } : state;
}
