"use client";

import { useMemo, useRef } from "react";

export type TerminalV2SuggestionAdapter = {
  remainderChanged(remainder: string): void;
  layoutChanged(): void;
};

export type UseTerminalV2SuggestionsOptions = {
  onSuggestionRemainderChange?: (remainder: string) => void;
  onSuggestionLayoutChange?: () => void;
};

export type UseTerminalV2SuggestionsResult = {
  suggestionAdapter: TerminalV2SuggestionAdapter;
  getRemainder(): string;
};

export function useTerminalV2Suggestions({
  onSuggestionRemainderChange,
  onSuggestionLayoutChange,
}: UseTerminalV2SuggestionsOptions): UseTerminalV2SuggestionsResult {
  const remainderRef = useRef("");

  const suggestionAdapter = useMemo<TerminalV2SuggestionAdapter>(() => ({
    remainderChanged(remainder) {
      remainderRef.current = remainder;
      onSuggestionRemainderChange?.(remainder);
    },
    layoutChanged() {
      onSuggestionLayoutChange?.();
    },
  }), [onSuggestionLayoutChange, onSuggestionRemainderChange]);

  return {
    suggestionAdapter,
    getRemainder: () => remainderRef.current,
  };
}
