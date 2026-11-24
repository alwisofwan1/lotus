import type { CanvasVoiceContext } from "./canvas-voice-context";
import type { VoiceInputSettings, VoiceMode } from "./voice-mode";
import { resolveVoiceOutcome, type VoiceRouterDeps } from "./voice-intent-router";

/**
 * The **Composer Target** of the Canvas command bar: where Enter sends what is in the field right
 * now (plans/composer-voice-ux, ticket 07). `decides` = the fast path could not place it, so Lotus
 * works it out — the bar says so rather than guessing an agent.
 */
export type ComposerTarget =
  | { to: "lotus"; decides: boolean }
  | { to: "agent" | "terminal" | "note"; /** The agent id for an agent, the node id otherwise. */ id: string; name: string };

export interface ComposerTargetDeps extends VoiceRouterDeps {
  /** A terminal named in the words ("Terminal 1, ls"): typed Enter delivers to it before routing. */
  addressedTerminal?: (text: string) => { nodeId: string; nodeName: string } | null;
}

// Only the route matters here, never whether it runs or waits: these settings can't change it.
const ROUTE_ONLY: VoiceInputSettings = {
  autoSubmit: true,
  minWordsToSubmit: 1,
  polish: false,
  autoCleanup: false,
  dictationMode: "clean",
  sendRightAway: false,
};

/**
 * The Voice Intent Router's fast path, read before Enter: no model call, so it can run on every
 * keystroke and every transcribed word. An empty field is labelled as prose would go.
 */
export function composerTargetFor(
  text: string,
  ctx: CanvasVoiceContext,
  deps: ComposerTargetDeps,
  forcedMode?: VoiceMode,
): ComposerTarget {
  const trimmed = text.trim();
  const focus = ctx.focus;
  // In the router's own order: selection, then agent, then terminal.
  if (!trimmed) {
    if (forcedMode === "command" || !focus) return { to: "lotus", decides: false };
    if (focus.selectedText && forcedMode !== "dictate") return { to: "note", id: focus.nodeId, name: focus.name };
    if (focus.agentId) return { to: "agent", id: focus.agentId, name: focus.name };
    if (focus.kind === "terminal") return { to: "terminal", id: focus.nodeId, name: focus.name };
    return { to: "lotus", decides: false };
  }
  const addressed = forcedMode ? null : deps.addressedTerminal?.(trimmed);
  if (addressed) return { to: "terminal", id: addressed.nodeId, name: addressed.nodeName };
  const outcome = resolveVoiceOutcome(trimmed, ctx, ROUTE_ONLY, deps, forcedMode);
  switch (outcome.kind) {
    case "dictate":
      return { to: "agent", id: outcome.agentId, name: outcome.agentName };
    case "terminal-submit":
    case "terminal-insert":
      return { to: "terminal", id: outcome.nodeId, name: outcome.nodeName };
    case "transform":
      return { to: "note", id: outcome.nodeId, name: focus?.name ?? "note" };
    default:
      return { to: "lotus", decides: forcedMode !== "command" && !deps.hasCommandVerb(trimmed) };
  }
}
