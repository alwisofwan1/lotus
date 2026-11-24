// Voice settings health (mockups/lotus-voice-settings.pen, frames 02 and 06): what each card's
// status light says, from real checks — the active engine, whether its key is stored, and the
// last test the user ran — never from settings alone. Pure, so the rules are tested without UI.

import type { EngineSummary } from "@/modules/codecanvas/services/voice/engine-summary";

export type VoiceCapability = "listen" | "speak" | "live";

/** Why a test failed, as far as the error text tells. Drives the card's one fix. */
export type VoiceProblem = "needs-key" | "key-refused" | "mic-blocked" | "failed";

export interface VoiceTestResult {
  /** The engine the test ran against; a result for another engine is stale. */
  engineId: string;
  at: number;
  ok: boolean;
  /** Push-to-Talk: stop → text. Speak: start → done. */
  ms?: number;
  problem?: VoiceProblem;
  /** The raw error, shown under the card's problem line. */
  error?: string;
}

export type VoiceTone = "ok" | "warn" | "err" | "off" | "busy";

export interface VoiceStatus {
  tone: VoiceTone;
  label: string;
  /** Set when the card shows a problem box with one fix. */
  problem?: VoiceProblem;
  /** The problem's headline and one-line explanation. */
  what?: string;
  why?: string;
}

/** Sort an error into the card's fixes. Rust voice errors read "… failed (HTTP 401): …" and
 *  "provider 'x' has no API key configured"; the webview rejects the mic with NotAllowedError. */
export function classifyVoiceError(message: string): VoiceProblem {
  if (/no api key/i.test(message)) return "needs-key";
  if (/HTTP 40[13]\b|unauthori[sz]ed|invalid[_ ]api[_ ]key|incorrect api key/i.test(message)) return "key-refused";
  if (/notallowed|not-allowed|permission|denied|microphone/i.test(message)) return "mic-blocked";
  return "failed";
}

interface StatusInput {
  capability: VoiceCapability;
  summary: EngineSummary | null;
  lastTest?: VoiceTestResult | null;
  testing?: boolean;
}

const KEY_WHY = "nothing is sent until a key is saved.";

/** The card's status light and, when something is wrong, its problem box. */
export function voiceCapabilityStatus({ capability, summary, lastTest, testing }: StatusInput): VoiceStatus {
  if (testing) return { tone: "busy", label: "Testing…" };
  // Live is optional: anything short of ready is simply Off, never a problem to fix.
  if (capability === "live" && !summary?.ready) return { tone: "off", label: "Off" };
  if (!summary) {
    return { tone: "warn", label: "Not set up", problem: "needs-key", what: "No engine chosen", why: "Pick an engine with Change." };
  }
  const engine = summary;
  if (engine.needsKey && !engine.hasKey) {
    return {
      tone: "warn",
      label: "Needs a key",
      problem: "needs-key",
      what: "No API key",
      why: `${engine.name} has no key saved, so ${KEY_WHY}`,
    };
  }
  const test = lastTest && lastTest.engineId === engine.id ? lastTest : null;
  if (test && !test.ok) {
    if (test.problem === "key-refused") {
      return {
        tone: "err",
        label: "Key refused",
        problem: "key-refused",
        what: "Key refused",
        why: `${engine.name} rejected the key — wrong or revoked.${capability === "speak" ? " Spoken replies stay silent until it is fixed." : ""}`,
      };
    }
    if (test.problem === "mic-blocked") {
      return {
        tone: "err",
        label: "Mic blocked",
        problem: "mic-blocked",
        what: "macOS blocked the microphone",
        why: "Allow Lotus in System Settings › Privacy › Microphone, then test again.",
      };
    }
    return { tone: "err", label: "Test failed", problem: test.problem ?? "failed", what: "The last test failed", why: test.error ?? "Try the test again." };
  }
  // A saved key is not a working key: Lotus never calls the provider until a Test does, so a
  // cloud engine reads "Key saved" until one passes.
  if (engine.needsKey && !test) return { tone: "ok", label: "Key saved" };
  return { tone: "ok", label: "Ready" };
}

/** "2 min ago · 0.6 s" — the card's "Last test" fact. */
export function describeLastTest(test: VoiceTestResult | null | undefined, now: number): string {
  if (!test) return "Never";
  const mins = Math.floor((now - test.at) / 60_000);
  const when = mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.floor(mins / 60)} h ago` : `${Math.floor(mins / 1440)} d ago`;
  if (!test.ok) return `${when} · failed`;
  return test.ms !== undefined ? `${when} · ${(test.ms / 1000).toFixed(1)} s` : when;
}
