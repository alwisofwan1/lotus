export type VoiceReplacementTiming = "before-ai" | "after-ai" | "both";

export interface VoiceReplacementRule {
  id: string;
  variants: readonly string[];
  replacement: string;
  timing: VoiceReplacementTiming;
  enabled: boolean;
}

const MAX_RULES = 256;
const MAX_VARIANTS_PER_RULE = 16;
const MAX_VARIANT_CHARS = 128;
const MAX_REPLACEMENT_CHARS = 256;
const WORD_CHAR = /[\p{L}\p{N}_]/u;

interface CompiledReplacement {
  variant: string;
  folded: string;
  replacement: string;
}

function appliesAt(timing: VoiceReplacementTiming, stage: Exclude<VoiceReplacementTiming, "both">): boolean {
  return timing === "both" || timing === stage;
}

function compileRules(
  rules: readonly VoiceReplacementRule[],
  stage: Exclude<VoiceReplacementTiming, "both">,
): CompiledReplacement[] {
  const seen = new Set<string>();
  const compiled: CompiledReplacement[] = [];
  for (const rule of rules.slice(0, MAX_RULES)) {
    if (!rule.enabled || !appliesAt(rule.timing, stage) || rule.replacement.length > MAX_REPLACEMENT_CHARS) continue;
    for (const raw of rule.variants.slice(0, MAX_VARIANTS_PER_RULE)) {
      const variant = raw.normalize("NFKC").trim();
      if (!variant || variant.length > MAX_VARIANT_CHARS) continue;
      const folded = variant.toLocaleLowerCase();
      if (seen.has(folded)) continue;
      seen.add(folded);
      compiled.push({ variant, folded, replacement: rule.replacement });
    }
  }
  return compiled.sort((a, b) => b.variant.length - a.variant.length);
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && WORD_CHAR.test(value);
}

function hasLiteralBoundaries(text: string, start: number, length: number): boolean {
  return !isWordCharacter(text[start - 1]) && !isWordCharacter(text[start + length]);
}

/**
 * Apply bounded literal corrections in one pass. Output is never re-scanned, preventing replacement
 * cascades; Unicode letter/number boundaries keep a term such as `cloud` out of `megacloud`.
 */
export function applyVoiceReplacements(
  transcript: string,
  rules: readonly VoiceReplacementRule[],
  stage: Exclude<VoiceReplacementTiming, "both">,
): string {
  const compiled = compileRules(rules, stage);
  if (!transcript || compiled.length === 0) return transcript;
  const foldedText = transcript.toLocaleLowerCase();
  let cursor = 0;
  let output = "";
  while (cursor < transcript.length) {
    const match = compiled.find(
      (candidate) =>
        foldedText.startsWith(candidate.folded, cursor) &&
        hasLiteralBoundaries(transcript, cursor, candidate.variant.length),
    );
    if (!match) {
      output += transcript[cursor];
      cursor += 1;
      continue;
    }
    output += match.replacement;
    cursor += match.variant.length;
  }
  return output;
}
