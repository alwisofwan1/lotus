import type { AgentStatusSnapshot } from "../agent-status-registry";
import { terminalAliases, terminalDisplayName } from "../terminal/terminal-node-identity";

/**
 * The live "vocabulary" of a canvas — the live agent names plus every node's display name, deduped and
 * trimmed. It feeds two places that must agree (ADR-0034, Option B):
 *   • STT decoder biasing — so spoken handles like "Ren"/"Sora" aren't misheard as common words;
 *   • the dictation polish step — as the allow-list it corrects obvious mis-hearings toward.
 * Single source so biasing and correction can never drift. Pure.
 */
export function buildCanvasVocabulary(input: {
  roster: readonly AgentStatusSnapshot[];
  nodeNames: readonly string[];
}): string[] {
  const all = [...input.roster.map((a) => a.name), ...input.nodeNames];
  return Array.from(new Set(all.map((s) => (s ?? "").trim()).filter(Boolean)));
}

/**
 * Voice-recognition names for canvas nodes. A renamed terminal retains its `Terminal N` alias so
 * existing spoken habits and explicit NL addressing keep resolving to the same runtime pane.
 */
export function canvasVoiceNodeNames(nodes: readonly { type?: string; data?: unknown }[]): string[] {
  return nodes.flatMap((node) => {
    const data = (node.data ?? {}) as Record<string, unknown>;
    if (node.type === "terminal") {
      const identity = { label: data.label, terminalNumber: data.terminalNumber };
      return [terminalDisplayName(identity), ...terminalAliases(identity)];
    }
    return typeof data.name === "string" ? [data.name] : [];
  });
}
