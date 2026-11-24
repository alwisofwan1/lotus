export type TerminalV2RevealState = "hidden" | "warming" | "settled";

export type TerminalV2RevealPolicyInput = {
  active: boolean;
  hasTerminal: boolean;
  hasRenderedOnce: boolean;
  currentGeneration: number;
};

export type TerminalV2RevealPolicyDecision = {
  generation: number;
  revealState: TerminalV2RevealState;
  cancelSettle: boolean;
  scheduleFallback: boolean;
};

export function resolveTerminalV2RevealPolicy({
  active,
  hasTerminal,
  hasRenderedOnce,
  currentGeneration,
}: TerminalV2RevealPolicyInput): TerminalV2RevealPolicyDecision {
  const generation = currentGeneration + 1;
  if (!active) {
    return {
      generation,
      revealState: "hidden",
      cancelSettle: true,
      scheduleFallback: false,
    };
  }

  if (!hasTerminal) {
    return {
      generation,
      revealState: "warming",
      cancelSettle: false,
      scheduleFallback: false,
    };
  }

  if (hasRenderedOnce) {
    return {
      generation,
      revealState: "settled",
      cancelSettle: true,
      scheduleFallback: false,
    };
  }

  return {
    generation,
    revealState: "warming",
    cancelSettle: false,
    scheduleFallback: true,
  };
}
