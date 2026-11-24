import type { ISearchOptions } from "@xterm/addon-search";

export type TerminalSearchMode = "live" | "navigate";

export type TerminalSearchDirection = "next" | "previous";

export type TerminalSearchFallbackTerminal = {
  buffer?: {
    active?: {
      length?: number;
      baseY?: number;
      cursorY?: number;
      getLine?(index: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
  clearSelection?(): void;
  getSelection?(): string;
  getSelectionPosition?(): { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;
  hasSelection?(): boolean;
  refresh?(start: number, end: number): void;
  scrollToLine?(line: number): void;
  select?(column: number, row: number, length: number): void;
};

const TERMINAL_SEARCH_DECORATIONS: NonNullable<ISearchOptions["decorations"]> = {
  matchBackground: "#515c6a",
  matchOverviewRuler: "#d18616",
  activeMatchBackground: "#d18616",
  activeMatchColorOverviewRuler: "#d18616",
};

export function createTerminalSearchOptions(mode: TerminalSearchMode = "navigate"): ISearchOptions {
  return {
    decorations: TERMINAL_SEARCH_DECORATIONS,
    ...(mode === "live" ? { incremental: true } : null),
  };
}

export function hasVisibleTerminalSearchSelection(
  terminal: TerminalSearchFallbackTerminal | null | undefined,
  query: string,
): boolean {
  if (!query || !terminal?.hasSelection?.()) return false;
  const selection = terminal.getSelection?.() ?? "";
  return selection.localeCompare(query, undefined, { sensitivity: "accent" }) === 0;
}

export function repaintTerminalSearchSelection(
  terminal: TerminalSearchFallbackTerminal | null | undefined,
  query: string,
): boolean {
  if (!hasVisibleTerminalSearchSelection(terminal, query)) return false;
  const selection = terminal?.getSelectionPosition?.();
  if (!selection || !terminal?.select) return false;

  const length = Math.max(1, (terminal.getSelection?.() ?? query).length);
  if (!safeSelect(terminal, selection.start.x, selection.start.y, length)) return false;
  safeRefresh(terminal, selection.start.y, selection.end.y);
  return true;
}

export function selectTerminalSearchFallbackMatch({
  direction,
  includeCurrentSelection = false,
  query,
  terminal,
}: {
  direction: TerminalSearchDirection;
  includeCurrentSelection?: boolean;
  query: string;
  terminal: TerminalSearchFallbackTerminal | null | undefined;
}): boolean {
  const normalizedQuery = query.trim();
  const buffer = terminal?.buffer?.active;
  const getLine = buffer?.getLine;
  if (!normalizedQuery || !buffer || !getLine || !terminal?.select) return false;

  const lineCount = Math.max(0, Math.floor(buffer.length ?? 0));
  if (lineCount === 0) return false;

  const selection = terminal.getSelectionPosition?.();
  const cursorRow = Math.max(0, Math.min(lineCount - 1, (buffer.baseY ?? 0) + (buffer.cursorY ?? 0)));
  const startRow = selection?.start.y ?? cursorRow;
  const startColumn = selection?.start.x ?? 0;
  const queryLower = normalizedQuery.toLocaleLowerCase();
  const rowOrder = direction === "previous"
    ? createReverseRowOrder(lineCount, startRow)
    : createForwardRowOrder(lineCount, startRow);

  for (const row of rowOrder) {
    const text = getLine.call(buffer, row)?.translateToString(true) ?? "";
    const textLower = text.toLocaleLowerCase();
    const column = direction === "previous"
      ? findPreviousColumn(textLower, queryLower, row === startRow && !includeCurrentSelection ? startColumn - 1 : undefined)
      : findNextColumn(textLower, queryLower, row === startRow && !includeCurrentSelection ? startColumn + 1 : startColumn);
    if (column < 0) continue;
    if (!safeSelect(terminal, column, row, normalizedQuery.length)) continue;
    safeScrollToLine(terminal, row);
    safeRefresh(terminal, row, row);
    return true;
  }

  return false;
}

function safeScrollToLine(terminal: TerminalSearchFallbackTerminal, row: number): void {
  try {
    terminal.scrollToLine?.(row);
  } catch {
    // xterm can throw here when a WebView renderer is hidden/disposed while the buffer still exists.
  }
}

function safeSelect(
  terminal: TerminalSearchFallbackTerminal,
  column: number,
  row: number,
  length: number,
): boolean {
  try {
    terminal.select?.(column, row, length);
    return true;
  } catch {
    return false;
  }
}

function safeRefresh(terminal: TerminalSearchFallbackTerminal, start: number, end: number): void {
  try {
    terminal.refresh?.(start, end);
  } catch {
    // Refresh is best-effort; search should never crash if the renderer is temporarily unavailable.
  }
}

function createForwardRowOrder(lineCount: number, startRow: number): number[] {
  return [
    ...Array.from({ length: lineCount - startRow }, (_, index) => startRow + index),
    ...Array.from({ length: startRow }, (_, index) => index),
  ];
}

function createReverseRowOrder(lineCount: number, startRow: number): number[] {
  return [
    ...Array.from({ length: startRow + 1 }, (_, index) => startRow - index),
    ...Array.from({ length: lineCount - startRow - 1 }, (_, index) => lineCount - index - 1),
  ];
}

function findNextColumn(textLower: string, queryLower: string, startColumn = 0): number {
  return textLower.indexOf(queryLower, Math.max(0, startColumn));
}

function findPreviousColumn(textLower: string, queryLower: string, beforeColumn = textLower.length): number {
  return textLower.lastIndexOf(queryLower, Math.max(0, beforeColumn));
}
