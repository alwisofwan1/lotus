import type { S2sPhase } from "@/modules/voice-core/s2s-session";
import type { S2sToolHealth } from "./use-s2s-session";

export interface S2sActivityHintInput {
  fallback: string;
  phase: S2sPhase;
  tools?: S2sToolHealth;
  lastTool?: string;
}

/** Truthful, terse progress copy for the otherwise opaque post-speech interval. */
export function resolveS2sActivityHint({
  fallback,
  phase,
  tools = "idle",
  lastTool,
}: S2sActivityHintInput): string {
  if (phase !== "thinking") return fallback;
  if (tools === "running") {
    return lastTool === "dispatch" ? "Preparing handoff…" : "Running requested action…";
  }
  if (tools === "ok" || tools === "error") return "Preparing response…";
  return "Finishing your turn…";
}
