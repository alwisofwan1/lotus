import { tauriVoicePort } from "@/modules/voice-core/tauri-voice-port";
import type { S2sPhase } from "@/modules/voice-core/s2s-session";
import type { S2sToolCall } from "./s2s-stream-bridge";
import type { S2sLatencyTracker } from "./s2s-latency-tracker";
import { createS2sToolResultBatcher } from "./s2s-tool-result-batcher";
import { resolveConciergeAction, type ConciergeAction } from "./s2s-concierge-bridge";
import { isS2sEndConversationCall, resolveS2sEndFarewell } from "./s2s-end-conversation";
import type { S2sAutoEndReason } from "./s2s-auto-end-policy";

export type S2sToolRuntimeHealth = "idle" | "running" | "ok" | "error";

export interface S2sToolRuntimeHealthPatch {
  tools: S2sToolRuntimeHealth;
  lastIssue?: string;
  lastTool?: string;
}

export interface S2sToolCallRuntimeDeps {
  getSessionId: () => string | null;
  getPhase: () => S2sPhase;
  getTurn: () => number;
  getHandler: () => ((action: ConciergeAction, call: S2sToolCall) => unknown | Promise<unknown>) | undefined;
  updateHealth: (patch: S2sToolRuntimeHealthPatch, record?: boolean) => void;
  markTurnSettled: () => void;
  requestGracefulEnd: (reason: S2sAutoEndReason, farewell: string) => void;
  /** Veto for `end_conversation`: why the session must stay open, or null to end it. */
  checkEnd?: () => Promise<string | null>;
  latencyTracker: Pick<S2sLatencyTracker, "markToolStart" | "markToolEnd">;
  sendToolResult?: (
    sessionId: string,
    callId: string,
    output: string,
    continueResponse?: boolean,
  ) => Promise<void>;
}

export interface S2sToolCallRuntime {
  handle: (call: S2sToolCall) => void;
  markResponseDone: () => void;
  reset: () => void;
}

export function sanitizeRealtimeToolOutput(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") return { ok: true };
  const record = result as Record<string, unknown>;
  const output: Record<string, unknown> = { ok: record.ok === false ? false : true };
  if (typeof record.speak === "string" && record.speak.trim()) output.speak = record.speak.trim();
  if (typeof record.summary === "string" && record.summary.trim()) output.summary = record.summary.trim();
  if (typeof record.error === "string" && record.error.trim()) output.error = record.error.trim();
  const clarify = record.clarify;
  if (clarify && typeof clarify === "object") {
    const c = clarify as Record<string, unknown>;
    const labels = Array.isArray(c.candidates)
      ? c.candidates
          .map((candidate) => (candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>).label : candidate))
          .filter((label): label is string => typeof label === "string" && !!label.trim())
          .map((label) => label.trim())
      : [];
    output.clarify = {
      ...(typeof c.ambiguousName === "string" && c.ambiguousName.trim() ? { ambiguousName: c.ambiguousName.trim() } : {}),
      ...(typeof c.question === "string" && c.question.trim() ? { question: c.question.trim() } : {}),
      ...(labels.length ? { candidates: labels } : {}),
    };
  }
  if (typeof record.queued === "boolean") output.queued = record.queued;
  if (record.delivery === "queued" || record.delivery === "written") {
    output.delivery = record.delivery;
  }
  return output;
}

/** Owns realtime tool dedupe, stale-turn rejection, local execution, and batched continuation. */
export function createS2sToolCallRuntime({
  getSessionId,
  getPhase,
  getTurn,
  getHandler,
  updateHealth,
  markTurnSettled,
  requestGracefulEnd,
  checkEnd = async () => null,
  latencyTracker,
  sendToolResult = tauriVoicePort.s2s.toolResult,
}: S2sToolCallRuntimeDeps): S2sToolCallRuntime {
  const handledCallIds = new Set<string>();
  const batcher = createS2sToolResultBatcher({
    send: (result, continueResponse) => {
      const sessionId = getSessionId();
      if (!sessionId) throw new Error("Realtime voice session closed before tool result delivery.");
      return sendToolResult(sessionId, result.callId, result.output, continueResponse);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      updateHealth({ tools: "error", lastIssue: message }, true);
    },
  });

  return {
    handle(call) {
      if (handledCallIds.has(call.callId)) return;
      handledCallIds.add(call.callId);
      const sessionId = getSessionId();

      if (getPhase() === "user") {
        const message = "Tool call ignored because the user is still speaking.";
        updateHealth({ tools: "error", lastTool: call.name, lastIssue: message }, true);
        if (sessionId) {
          void sendToolResult(
            sessionId,
            call.callId,
            JSON.stringify({ ok: false, error: message }),
            false,
          );
        }
        return;
      }

      batcher.begin(call.callId);
      latencyTracker.markToolStart(getTurn(), call.callId);
      if (isS2sEndConversationCall(call.name)) {
        void checkEnd().then((refusal) => {
          console.info(`[s2s] end_conversation ${refusal ? `refused — ${refusal}` : "accepted"}`);
          updateHealth({ tools: "ok", lastTool: call.name }, true);
          const farewell = resolveS2sEndFarewell(call.args);
          if (getSessionId()) {
            void batcher.complete(
              call.callId,
              JSON.stringify(refusal ? { ok: false, error: refusal } : { ok: true, speak: farewell }),
            );
          }
          latencyTracker.markToolEnd(call.callId);
          if (!refusal) requestGracefulEnd("voice-command", farewell);
        });
        return;
      }

      const handler = getHandler();
      updateHealth({ tools: "running", lastTool: call.name }, true);
      if (!sessionId || !handler) return;
      void Promise.resolve(handler(resolveConciergeAction(call), call))
        .then((result) => {
          latencyTracker.markToolEnd(call.callId);
          const sanitized = sanitizeRealtimeToolOutput(result);
          updateHealth({
            tools: sanitized.ok === false ? "error" : "ok",
            lastIssue: typeof sanitized.error === "string" ? sanitized.error : undefined,
          }, true);
          if (!sanitized.clarify) markTurnSettled();
          return batcher.complete(call.callId, JSON.stringify(sanitized));
        })
        .catch((error) => {
          latencyTracker.markToolEnd(call.callId);
          const message = error instanceof Error ? error.message : String(error);
          updateHealth({ tools: "error", lastIssue: message }, true);
          return batcher.complete(
            call.callId,
            JSON.stringify({ ok: false, error: message }),
          );
        });
    },

    markResponseDone() {
      void batcher.markResponseDone();
    },

    reset() {
      handledCallIds.clear();
      batcher.reset();
    },
  };
}
