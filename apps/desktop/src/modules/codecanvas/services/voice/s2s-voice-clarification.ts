import { foldForMatch, normalizeNameQuery } from "../canvas-name-match";
import type { S2sCanvasToolResult } from "./s2s-canvas-tool-executor";
import type { S2sToolCall } from "./s2s-stream-bridge";
import type { RealtimeTool } from "./s2s-concierge-bridge";

export const S2S_CHOOSE_TARGET_TOOL_NAME = "choose_target";
export const S2S_CLARIFICATION_TTL_MS = 45_000;

export const S2S_CHOOSE_TARGET_TOOL: RealtimeTool = {
  type: "function",
  name: S2S_CHOOSE_TARGET_TOOL_NAME,
  description:
    "Continue the previous ambiguous Canvas action after Lotus asked which target. Use only when the user answers with a visible candidate name like Sena, Nara, or Bima.",
  parameters: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "The visible candidate name the user chose, exactly as spoken or shown.",
      },
    },
    required: ["target"],
  },
};

export interface S2sPendingClarification {
  originalCall: S2sToolCall;
  question: string;
  candidates: string[];
  expiresAtMs: number;
}

export interface S2sVoiceClarificationState {
  pending?: S2sPendingClarification;
}

export type S2sClarificationResolution =
  | { kind: "execute"; call: S2sToolCall; state: S2sVoiceClarificationState }
  | { kind: "result"; result: S2sCanvasToolResult; state: S2sVoiceClarificationState }
  | { kind: "pass"; call: S2sToolCall; state: S2sVoiceClarificationState };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function candidateLabels(result: S2sCanvasToolResult): string[] {
  if (result.ok || !result.clarify) return [];
  return result.clarify.candidates.map((candidate) => candidate.label).filter(Boolean);
}

export function recordS2sPendingClarification(
  state: S2sVoiceClarificationState,
  call: S2sToolCall,
  result: S2sCanvasToolResult,
  nowMs = Date.now(),
  ttlMs = S2S_CLARIFICATION_TTL_MS,
): S2sVoiceClarificationState {
  if (result.ok) return {};
  const labels = candidateLabels(result);
  if (!result.clarify || labels.length === 0) return state;
  return {
    pending: {
      originalCall: call,
      question: result.clarify.question,
      candidates: labels,
      expiresAtMs: nowMs + ttlMs,
    },
  };
}

function matchChoice(target: string, candidates: readonly string[]): string | null {
  const normalized = normalizeNameQuery(target);
  const folded = foldForMatch(target);
  const exact = candidates.find((candidate) => normalizeNameQuery(candidate) === normalized);
  if (exact) return exact;
  const foldedExact = candidates.find((candidate) => foldForMatch(candidate) === folded);
  if (foldedExact) return foldedExact;
  const partial = candidates.filter((candidate) => normalizeNameQuery(candidate).includes(normalized));
  return partial.length === 1 ? partial[0] : null;
}

export function resolveS2sClarificationCall(
  call: S2sToolCall,
  state: S2sVoiceClarificationState,
  nowMs = Date.now(),
): S2sClarificationResolution {
  if (call.name !== S2S_CHOOSE_TARGET_TOOL_NAME) return { kind: "pass", call, state };
  if (!state.pending) {
    return {
      kind: "result",
      state,
      result: { ok: false, error: "No pending target choice.", speak: "I’m not choosing between anything right now." },
    };
  }
  if (nowMs > state.pending.expiresAtMs) {
    return {
      kind: "result",
      state: {},
      result: { ok: false, error: "Pending target choice expired.", speak: "That choice expired — please ask again." },
    };
  }
  const target = str(call.args.target);
  if (!target) {
    return {
      kind: "result",
      state,
      result: { ok: false, error: "No target choice provided.", speak: state.pending.question },
    };
  }
  const chosen = matchChoice(target, state.pending.candidates);
  if (!chosen) {
    return {
      kind: "result",
      state,
      result: {
        ok: false,
        error: `No clarification candidate named ${target}.`,
        speak: state.pending.question,
        clarify: {
          ambiguousName: target,
          question: state.pending.question,
          candidates: state.pending.candidates.map((label) => ({ id: label, label })),
        },
      },
    };
  }
  return {
    kind: "execute",
    state: {},
    call: {
      ...state.pending.originalCall,
      callId: call.callId,
      args: { ...state.pending.originalCall.args, target: chosen },
    },
  };
}
