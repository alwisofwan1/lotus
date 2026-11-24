import { foldForMatch, normalizeNameQuery } from "../canvas-name-match";
import { levenshtein } from "../runner-fuzzy";
import type { NlCommandContext } from "../canvas-nl-command";

export type S2sVoiceTargetConfidence =
  | { level: "high"; label: string; reason: "visible-exact" | "alias-exact" | "explicit-ordinal" }
  | { level: "medium"; label: string; reason: "partial" | "fuzzy" }
  | { level: "low"; reason: "not-found" | "ambiguous"; candidates?: string[] };

function namesForAgent(agent: { name: string; aliases?: string[] }): string[] {
  return [agent.name, ...(agent.aliases ?? [])].filter(Boolean);
}

function uniqueLabels(labels: string[]): string[] {
  return Array.from(new Set(labels));
}

function explicitOrdinal(text: string): boolean {
  return /\b(?:claude|cloud|codex|cursor|gemini|aider|opencode|open\s*code)[\s_-]+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(text);
}

export function assessS2sVoiceAgentTargetConfidence(target: string, ctx: NlCommandContext): S2sVoiceTargetConfidence {
  const query = normalizeNameQuery(target);
  const folded = foldForMatch(target);
  if (!query) return { level: "low", reason: "not-found" };

  const visible = ctx.roster.filter((agent) => normalizeNameQuery(agent.name) === query);
  if (visible.length === 1) return { level: "high", label: visible[0].name, reason: "visible-exact" };
  if (visible.length > 1) return { level: "low", reason: "ambiguous", candidates: uniqueLabels(visible.map((agent) => agent.name)) };

  const exactAlias = ctx.roster.filter((agent) => namesForAgent(agent).some((name) => foldForMatch(name) === folded));
  if (exactAlias.length === 1) {
    return { level: "high", label: exactAlias[0].name, reason: explicitOrdinal(target) ? "explicit-ordinal" : "alias-exact" };
  }
  if (exactAlias.length > 1) return { level: "low", reason: "ambiguous", candidates: uniqueLabels(exactAlias.map((agent) => agent.name)) };

  const partial = ctx.roster.filter((agent) => namesForAgent(agent).some((name) => normalizeNameQuery(name).includes(query)));
  if (partial.length === 1) return { level: "medium", label: partial[0].name, reason: "partial" };
  if (partial.length > 1) return { level: "low", reason: "ambiguous", candidates: uniqueLabels(partial.map((agent) => agent.name)) };

  const threshold = folded.length >= 3 ? Math.min(2, Math.max(1, Math.floor(folded.length / 4))) : 0;
  if (threshold >= 1) {
    const scored = ctx.roster
      .map((agent) => ({ agent, dist: Math.min(...namesForAgent(agent).map((name) => levenshtein(foldForMatch(name), folded))) }))
      .filter((score) => score.dist <= threshold)
      .sort((a, b) => a.dist - b.dist);
    if (scored.length === 1 || (scored.length > 1 && scored[1].dist - scored[0].dist >= 1)) {
      return { level: "medium", label: scored[0].agent.name, reason: "fuzzy" };
    }
    if (scored.length > 1) return { level: "low", reason: "ambiguous", candidates: uniqueLabels(scored.map((score) => score.agent.name)) };
  }

  return { level: "low", reason: "not-found" };
}
