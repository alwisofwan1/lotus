import {
  resolveTerminalV2ResizeEvent,
  type TerminalV2PtyResizeDebouncer,
  type TerminalV2ResizeEventInput,
} from "../geometry/terminal-v2-geometry-event-adapter";

export type TerminalV2NativeResizeTerminal = {
  cols?: number;
  rows?: number;
};

export type TerminalV2NativeResizeFitAddon = {
  fit(): void;
  proposeDimensions?: () => { cols: number; rows: number } | undefined;
};

export type TerminalV2NativeResizeBindingOptions = {
  active: boolean;
  fitAddon: TerminalV2NativeResizeFitAddon;
  isLiveResizeActive?: () => boolean;
  /**
   * True while another renderer is the one the user sees for this pane. Its geometry is the one the
   * PTY must follow, so this binding stays quiet: reflowing a hidden xterm costs a full layout pass
   * and a second PTY resize source makes cols/rows flip-flop. The coordinator fits this renderer
   * when it takes over.
   */
  isRendererStandby?: () => boolean;
  lastFittedGeometryRef: { current: { cols: number | null; rows: number | null } };
  resizeDebouncer: TerminalV2PtyResizeDebouncer;
  resolveResizeEvent?: (input: TerminalV2ResizeEventInput) => { kind: "ignore" | "skip-fit" | "fit" };
  suggestionAdapter?: { layoutChanged(): void };
  terminal: TerminalV2NativeResizeTerminal;
};

export type TerminalV2NativeResizeBinding = {
  performResizeFit(): void;
  updateLastFittedGeometry(): void;
};

export function createTerminalV2NativeResizeBinding({
  active,
  fitAddon,
  isLiveResizeActive = () => false,
  isRendererStandby = () => false,
  lastFittedGeometryRef,
  resizeDebouncer,
  resolveResizeEvent = resolveTerminalV2ResizeEvent,
  suggestionAdapter,
  terminal,
}: TerminalV2NativeResizeBindingOptions): TerminalV2NativeResizeBinding {
  const updateLastFittedGeometry = () => {
    if (Number.isFinite(terminal.cols)) lastFittedGeometryRef.current.cols = terminal.cols!;
    if (Number.isFinite(terminal.rows)) lastFittedGeometryRef.current.rows = terminal.rows!;
  };

  return {
    updateLastFittedGeometry,
    performResizeFit() {
      if (isLiveResizeActive() || isRendererStandby()) return;
      const proposal = fitAddon.proposeDimensions?.();
      const decision = resolveResizeEvent({
        active,
        liveResizeActive: false,
        lastFittedCols: lastFittedGeometryRef.current.cols,
        lastFittedRows: lastFittedGeometryRef.current.rows,
        proposedCols: proposal?.cols,
        proposedRows: proposal?.rows,
      });
      if (decision.kind !== "fit") return;

      fitAddon.fit();
      updateLastFittedGeometry();
      const { cols, rows } = terminal;
      if (Number.isFinite(cols) && Number.isFinite(rows)) resizeDebouncer.schedule(cols!, rows!);
      suggestionAdapter?.layoutChanged();
    },
  };
}
