export type SpokenResponseKind = "acknowledgement" | "clarification" | "result";

export type SpokenResponseVerbosity = "brief" | "normal" | "expressive";

export interface SpokenResponsePolicyInput {
  kind: SpokenResponseKind;
  verbosity?: SpokenResponseVerbosity;
}

export interface SpokenResponsePolicy {
  maxSentences: number;
  maxWords?: number;
  maxQuestions?: number;
  includeEvidence: boolean;
  includeNextAction: boolean;
}

/**
 * Resolves spoken-channel depth without constraining the separate worker delegation payload.
 */
export function resolveSpokenResponsePolicy({
  kind,
  verbosity = "normal",
}: SpokenResponsePolicyInput): SpokenResponsePolicy {
  if (kind === "acknowledgement") {
    return {
      maxSentences: 1,
      maxWords: 14,
      includeEvidence: false,
      includeNextAction: false,
    };
  }
  if (kind === "clarification") {
    return {
      maxSentences: 1,
      maxQuestions: 1,
      includeEvidence: false,
      includeNextAction: false,
    };
  }

  const resultSentences: Record<SpokenResponseVerbosity, number> = {
    brief: 2,
    normal: 3,
    expressive: 5,
  };
  return {
    maxSentences: resultSentences[verbosity],
    includeEvidence: true,
    includeNextAction: true,
  };
}

/** Builds the realtime prompt section from the same policy exercised by callers and tests. */
export function buildSpokenResponsePolicyInstructions(
  verbosity: SpokenResponseVerbosity = "normal",
): readonly string[] {
  const acknowledgement = resolveSpokenResponsePolicy({ kind: "acknowledgement", verbosity });
  const clarification = resolveSpokenResponsePolicy({ kind: "clarification", verbosity });
  const result = resolveSpokenResponsePolicy({ kind: "result", verbosity });

  return [
    "## Personality and Tone",
    "Speak like a calm world-class cockpit copilot: Natural, warm, and direct, never robotic.",
    "## Language",
    // Scoped deliberately to what is actually SPOKEN. This clause exists so technical vocabulary
    // survives a reply in the user's language — it must not read as licence to recite a file path,
    // which the delivery rules forbid outright. Naming "paths" here put the two in direct conflict.
    "Reply in the user's language. Preserve technical terms, names, numbers, and versions verbatim; never translate or paraphrase them.",
    "## Verbosity",
    `Routine acknowledgements: at most ${acknowledgement.maxSentences} sentence and ${acknowledgement.maxWords} words.`,
    `Clarifications: ask at most ${clarification.maxQuestions} clear question in ${clarification.maxSentences} sentence, then wait.`,
    `Evidence-bearing results: up to ${result.maxSentences} sentences. Include the key evidence and the next action when one exists.`,
  ];
}
