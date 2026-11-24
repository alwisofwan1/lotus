import type { CanvasVoiceContext } from "./canvas-voice-context";
import type { VoiceInputSettings, VoiceMode } from "./voice-mode";
import { isRepositoryWorkRequest } from "../repository-work-request";

/**
 * Voice Intent Router (ADR-0034) — the pure core of Voice Auto Mode. Given a finalized transcript, the
 * Canvas Voice Context, and any explicit forced mode, it resolves the single Voice Outcome the command
 * bar should carry out. It supersedes `resolveVoiceAction` and absorbs the dictation-target resolution
 * that used to live inline in the command bar, so the whole decision is one tested surface.
 *
 * Routing (Auto): a canvas-command verb always wins — even with an agent focused (precedence); plain
 * prose with an agent focused dictates to it with zero model cost; anything else falls through to the
 * command pipeline (which may still be a compound command or a conversational query). The remappable
 * Command/Dictate shortcuts pass a one-turn `forcedMode` and bypass inference only for that capture.
 */
export type VoiceOutcome =
  /** Run the transcript through the NL pipeline (parse + refine + execute). */
  | { kind: "command"; text: string }
  /** Deliver the transcript to a resolved agent (the Focused Node). With `autoSend` off, a live PTY
   *  receives unsubmitted prompt text directly; the command bar is only the unavailable-target fallback. */
  | { kind: "dictate"; agentId: string; agentName: string; text: string; autoSend: boolean }
  /** Submit literal text to a focused plain Terminal node. */
  | { kind: "terminal-submit"; nodeId: string; nodeName: string; text: string }
  /** Type literal transcript text into a focused plain Terminal node without pressing Enter. */
  | { kind: "terminal-insert"; nodeId: string; nodeName: string; text: string }
  /** Rewrite the selected text in the Focused note per the transcript (Option D). */
  | { kind: "transform"; nodeId: string; instruction: string; selection: string }
  /** Hold the text in the bar for review — either too short to auto-run, or no agent to dictate to. */
  | { kind: "insert"; text: string; reason: "too-short" | "no-dictate-target" | "repository-needs-agent" }
  | { kind: "ignore" };

const EXPLICIT_AGENT_DISPATCH_RE =
  /^(?:tell|ask)\s+.+?\s+to\s+.+$|^[\p{L}][\p{L}\d _-]*?\s*[,:]\s*.+$/iu;

export interface VoiceRouterDeps {
  /** True if the transcript matches a local canvas-command verb (fast-path — zero model round-trip). */
  hasCommandVerb: (text: string) => boolean;
}

export function resolveVoiceOutcome(
  transcript: string,
  ctx: CanvasVoiceContext,
  settings: VoiceInputSettings,
  deps: VoiceRouterDeps,
  forcedMode?: VoiceMode,
): VoiceOutcome {
  const text = transcript.trim();
  if (!text) return { kind: "ignore" };

  const target = ctx.focus?.agentId ? { agentId: ctx.focus.agentId, agentName: ctx.focus.name } : null;
  const terminalTarget = ctx.focus?.kind === "terminal"
    ? { nodeId: ctx.focus.nodeId, nodeName: ctx.focus.name }
    : null;
  const selection = ctx.focus?.selectedText ?? "";

  const autoSend = settings.sendRightAway;
  const repositoryWork = isRepositoryWorkRequest(text);
  const explicitlyAddressed = EXPLICIT_AGENT_DISPATCH_RE.test(text);

  // Explicit overrides bypass all remaining inference.
  if (forcedMode === "dictate") {
    if (target) return { kind: "dictate", ...target, text, autoSend };
    if (ctx.focus?.kind === "terminal") {
      return {
        kind: "terminal-insert",
        nodeId: ctx.focus.nodeId,
        nodeName: ctx.focus.name,
        text,
      };
    }
    return { kind: "insert", text, reason: "no-dictate-target" };
  }

  // Untargeted repository work is never a utility-planner question. A coding agent can inspect the project;
  // without one selected, keep the exact request for review instead of fabricating an answer.
  if (repositoryWork && !explicitlyAddressed) {
    if (target) return { kind: "dictate", ...target, text, autoSend };
    if (terminalTarget) return { kind: "terminal-submit", ...terminalTarget, text };
    return { kind: "insert", text, reason: "repository-needs-agent" };
  }

  if (forcedMode === "command") return commandOrInsert(text, settings);

  // AUTO — a canvas-command verb always wins, even over a focused agent / selected text.
  if (deps.hasCommandVerb(text)) return commandOrInsert(text, settings);
  // Text selected in the Focused node → the utterance is an instruction to transform that selection.
  if (selection && ctx.focus) return { kind: "transform", nodeId: ctx.focus.nodeId, instruction: text, selection };
  // Plain prose with an agent focused → dictate to it (zero model).
  if (target) return { kind: "dictate", ...target, text, autoSend };
  // A focused plain Terminal is an explicit input target. Submit the user's literal text; the caller
  // owns PTY encoding and native write confirmation.
  if (terminalTarget) return { kind: "terminal-submit", ...terminalTarget, text };
  // Otherwise let the command pipeline decide (compound command, or a conversational answer).
  return commandOrInsert(text, settings);
}

/** Command vs held-for-review: the word floor guards against a stray short word auto-running. */
function commandOrInsert(text: string, settings: VoiceInputSettings): VoiceOutcome {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (settings.autoSubmit && words >= settings.minWordsToSubmit) return { kind: "command", text };
  return { kind: "insert", text, reason: "too-short" };
}
