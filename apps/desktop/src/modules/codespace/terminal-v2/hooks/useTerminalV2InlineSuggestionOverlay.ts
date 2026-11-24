import { useCallback, useRef, useState } from "react";

export type TerminalV2InlineSuggestionOverlay = {
  text: string;
  left: number;
  top: number;
};

type TerminalV2InlineSuggestionRuntime = {
  getPaneRendererHelperTextarea(paneId: string): HTMLTextAreaElement | null;
};

export type UseTerminalV2InlineSuggestionOverlayOptions = {
  paneId: string;
  runtime: TerminalV2InlineSuggestionRuntime | null | undefined;
  getContainer: () => HTMLElement | null;
  getFallbackHelperTextarea: () => HTMLTextAreaElement | null;
};

export function useTerminalV2InlineSuggestionOverlay({
  paneId,
  runtime,
  getContainer,
  getFallbackHelperTextarea,
}: UseTerminalV2InlineSuggestionOverlayOptions) {
  const overlayRef = useRef<TerminalV2InlineSuggestionOverlay | null>(null);
  const suggestionTextRef = useRef("");
  const [inlineSuggestionOverlay, setInlineSuggestionOverlay] = useState<TerminalV2InlineSuggestionOverlay | null>(null);

  const syncInlineSuggestionOverlay = useCallback((nextOverlay: TerminalV2InlineSuggestionOverlay | null) => {
    const currentOverlay = overlayRef.current;
    const unchanged = currentOverlay?.text === nextOverlay?.text
      && currentOverlay?.left === nextOverlay?.left
      && currentOverlay?.top === nextOverlay?.top;

    if (unchanged) return;

    overlayRef.current = nextOverlay;
    setInlineSuggestionOverlay(nextOverlay);
  }, []);

  const handleRuntimeSuggestionLayoutChange = useCallback(() => {
    const activeSuggestionRemainder = suggestionTextRef.current;
    if (!activeSuggestionRemainder) {
      syncInlineSuggestionOverlay(null);
      return;
    }

    const container = getContainer();
    const helperTextarea = runtime?.getPaneRendererHelperTextarea(paneId)
      ?? getFallbackHelperTextarea();

    if (!container || !helperTextarea) {
      syncInlineSuggestionOverlay(null);
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const helperRect = helperTextarea.getBoundingClientRect();

    syncInlineSuggestionOverlay({
      text: activeSuggestionRemainder,
      left: Math.max(0, helperRect.left - containerRect.left),
      top: Math.max(0, helperRect.top - containerRect.top),
    });
  }, [getContainer, getFallbackHelperTextarea, paneId, runtime, syncInlineSuggestionOverlay]);

  const handleRuntimeSuggestionRemainderChange = useCallback((remainder: string) => {
    suggestionTextRef.current = remainder;
    handleRuntimeSuggestionLayoutChange();
  }, [handleRuntimeSuggestionLayoutChange]);

  return {
    inlineSuggestionOverlay,
    handleRuntimeSuggestionRemainderChange,
    handleRuntimeSuggestionLayoutChange,
  };
}
