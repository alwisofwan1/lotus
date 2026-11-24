export type TerminalV2Geometry = {
  cols: number;
  rows: number;
  width: number;
  height: number;
};

export type TerminalV2ResizeEventInput = {
  active: boolean;
  liveResizeActive: boolean;
  lastFittedCols: number | null;
  lastFittedRows: number | null;
  proposedCols?: number | null;
  proposedRows?: number | null;
};

export type TerminalV2ResizeEventDecision =
  | { kind: "ignore"; reason: "inactive" | "live-resize" }
  | { kind: "skip-fit" }
  | { kind: "fit" };

export type TerminalV2InitialGeometryDecision =
  | { kind: "defer-start" }
  | { kind: "start-session"; geometry: TerminalV2Geometry };

export type TerminalV2CommitFitDecision =
  | { kind: "ignore"; reason: "inactive" }
  | { kind: "fit-and-flush" };

export type TerminalV2PtyResizeDebouncerOptions = {
  delayMs?: number;
  onResize: (cols: number, rows: number) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type TerminalV2PtyResizeDebouncer = {
  schedule(cols: number, rows: number): void;
  flush(): void;
  cancel(): void;
};

const DEFAULT_PTY_RESIZE_DEBOUNCE_MS = 256;

function shouldSkipProposedFit(input: TerminalV2ResizeEventInput): boolean {
  const { lastFittedCols, lastFittedRows, proposedCols, proposedRows } = input;
  if (proposedCols == null || proposedRows == null) return false;
  if (!Number.isFinite(proposedCols) || !Number.isFinite(proposedRows)) return false;
  if (lastFittedCols == null || lastFittedRows == null) return false;
  return proposedCols === lastFittedCols && proposedRows === lastFittedRows;
}

export function resolveTerminalV2ResizeEvent(input: TerminalV2ResizeEventInput): TerminalV2ResizeEventDecision {
  if (!input.active) return { kind: "ignore", reason: "inactive" };
  if (input.liveResizeActive) return { kind: "ignore", reason: "live-resize" };
  if (shouldSkipProposedFit(input)) return { kind: "skip-fit" };
  return { kind: "fit" };
}

export function resolveTerminalV2InitialGeometryEvent(
  geometry: TerminalV2Geometry | null,
): TerminalV2InitialGeometryDecision {
  return geometry ? { kind: "start-session", geometry } : { kind: "defer-start" };
}

export function resolveTerminalV2CommitFitEvent(
  input: { active: boolean },
): TerminalV2CommitFitDecision {
  return input.active ? { kind: "fit-and-flush" } : { kind: "ignore", reason: "inactive" };
}

export function createTerminalV2PtyResizeDebouncer({
  delayMs = DEFAULT_PTY_RESIZE_DEBOUNCE_MS,
  onResize,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout as (handle: unknown) => void,
}: TerminalV2PtyResizeDebouncerOptions): TerminalV2PtyResizeDebouncer {
  let timer: unknown = null;
  let pending: { cols: number; rows: number } | null = null;

  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const flush = () => {
    const next = pending;
    pending = null;
    cancel();
    if (next) onResize(next.cols, next.rows);
  };

  return {
    schedule(cols, rows) {
      pending = { cols, rows };
      cancel();
      timer = setTimer(flush, delayMs);
    },
    flush,
    cancel,
  };
}
