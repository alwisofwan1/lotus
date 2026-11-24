import {
  createTerminalSearchOptions,
  hasVisibleTerminalSearchSelection,
  repaintTerminalSearchSelection,
  selectTerminalSearchFallbackMatch,
  type TerminalSearchFallbackTerminal,
  type TerminalSearchMode,
} from "@/modules/codespace/services/terminal-search-options";

export type TerminalV2NativeSearchAddon = {
  findNext(query: string, options?: ReturnType<typeof createTerminalSearchOptions>): boolean;
  findPrevious(query: string, options?: ReturnType<typeof createTerminalSearchOptions>): boolean;
  clearDecorations(): void;
};

export type TerminalV2NativeSearchApi = {
  findNext(query: string, mode?: TerminalSearchMode): boolean;
  findPrevious(query: string): boolean;
  clearSearch(): void;
};

export type TerminalV2NativeSearchReadyOptions = {
  notifiedSearchAddonRef: { current: object | null };
  onSearchReady?: (api: TerminalV2NativeSearchApi) => void;
  searchAddon?: TerminalV2NativeSearchAddon | null;
  terminal?: TerminalSearchFallbackTerminal | null;
};

export function createTerminalV2NativeSearchApi(
  searchAddon?: TerminalV2NativeSearchAddon | null,
  terminal?: TerminalSearchFallbackTerminal | null,
): TerminalV2NativeSearchApi | null {
  if (!searchAddon) return null;
  return {
    findNext: (query, mode = "navigate") => {
      const matched = searchAddon.findNext(query, createTerminalSearchOptions(mode));
      if (hasVisibleTerminalSearchSelection(terminal, query)) {
        repaintTerminalSearchSelection(terminal, query);
        return matched;
      }
      return selectTerminalSearchFallbackMatch({
        direction: "next",
        includeCurrentSelection: mode === "live",
        query,
        terminal,
      }) || matched;
    },
    findPrevious: (query) => {
      const matched = searchAddon.findPrevious(query, createTerminalSearchOptions("navigate"));
      if (hasVisibleTerminalSearchSelection(terminal, query)) {
        repaintTerminalSearchSelection(terminal, query);
        return matched;
      }
      return selectTerminalSearchFallbackMatch({ direction: "previous", query, terminal }) || matched;
    },
    clearSearch: () => {
      searchAddon.clearDecorations();
      terminal?.clearSelection?.();
    },
  };
}

export function notifyTerminalV2NativeSearchReady({
  notifiedSearchAddonRef,
  onSearchReady,
  searchAddon,
  terminal,
}: TerminalV2NativeSearchReadyOptions): boolean {
  const api = createTerminalV2NativeSearchApi(searchAddon, terminal);
  if (!api || !onSearchReady || notifiedSearchAddonRef.current === searchAddon) return false;
  notifiedSearchAddonRef.current = searchAddon ?? null;
  onSearchReady(api);
  return true;
}
