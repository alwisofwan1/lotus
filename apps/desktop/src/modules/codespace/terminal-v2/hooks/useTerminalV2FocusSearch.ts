"use client";

import { useCallback, useRef } from "react";
import type { TerminalSearchMode } from "@/modules/codespace/services/terminal-search-options";

export type TerminalV2SearchApi = {
  findNext(query: string, mode?: TerminalSearchMode): boolean;
  findPrevious(query: string): boolean;
  clearSearch(): void;
};

export type TerminalV2FocusRendererHandles = {
  terminal: { rows: number; focus?: () => void };
};

export type UseTerminalV2FocusSearchOptions = {
  onSearchReady?: (api: TerminalV2SearchApi) => void;
};

export type UseTerminalV2FocusSearchResult = {
  focus(): void;
  onRendererHandlesReady(handles: TerminalV2FocusRendererHandles): () => void;
  onSearchReady(api: TerminalV2SearchApi): void;
  getSearchApi(): TerminalV2SearchApi | null;
};

export function useTerminalV2FocusSearch({
  onSearchReady,
}: UseTerminalV2FocusSearchOptions): UseTerminalV2FocusSearchResult {
  const terminalRef = useRef<TerminalV2FocusRendererHandles["terminal"] | null>(null);
  const searchApiRef = useRef<TerminalV2SearchApi | null>(null);

  const focus = useCallback(() => {
    terminalRef.current?.focus?.();
  }, []);

  const handleRendererHandlesReady = useCallback((handles: TerminalV2FocusRendererHandles) => {
    terminalRef.current = handles.terminal;
    return () => {
      if (terminalRef.current === handles.terminal) terminalRef.current = null;
    };
  }, []);

  const handleSearchReady = useCallback((api: TerminalV2SearchApi) => {
    searchApiRef.current = api;
    onSearchReady?.(api);
  }, [onSearchReady]);

  const getSearchApi = useCallback(() => searchApiRef.current, []);

  return {
    focus,
    onRendererHandlesReady: handleRendererHandlesReady,
    onSearchReady: handleSearchReady,
    getSearchApi,
  };
}
