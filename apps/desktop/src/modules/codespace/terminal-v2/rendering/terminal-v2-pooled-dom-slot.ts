import type { TerminalTheme } from "@/lib/design-system";
import type {
  TerminalV2FitAddonLike,
  TerminalV2XtermLike,
  TerminalV2XtermRendererSlot,
} from "./terminal-v2-xterm-renderer-host";

export type TerminalV2PooledRendererInputDisposable = { dispose(): void };

/** The look a renderer can change in place, without losing the scrollback it already holds. */
export type TerminalV2PooledRendererAppearance = {
  theme?: TerminalTheme;
  fontSize?: number;
};

export type TerminalV2PooledRenderer = {
  terminal: TerminalV2XtermLike;
  fitAddon: TerminalV2FitAddonLike;
  dispose(): void;
  captureSnapshot?(): string | null;
  helperTextarea?: HTMLTextAreaElement | null;
  onData?(listener: (data: string) => void): TerminalV2PooledRendererInputDisposable;
  onRender?(listener: () => void): TerminalV2PooledRendererInputDisposable;
  search?: TerminalV2XtermRendererSlot["search"];
  /**
   * The slot is now on screen inside a pane, or has gone back to the parking container.
   *
   * The slot itself owns no renderer policy — it only reports the transition. What a renderer
   * does with it (promote to an accelerated renderer, give the GPU context back) is the
   * renderer's business.
   */
  setVisible?(visible: boolean): void;
  setAppearance?(appearance: TerminalV2PooledRendererAppearance): void;
};

export type TerminalV2PooledDomSlotOptions = {
  slotId: string;
  parkingContainer: HTMLElement;
  resolvePaneContainer(paneId: string): HTMLElement | null;
  createRenderer(slotElement: HTMLElement, slotId: string): TerminalV2PooledRenderer;
  writePaneInput?(paneId: string, data: string): void;
  onFitGeometry?(paneId: string, cols: number, rows: number): void;
};

export type TerminalV2PooledDomSlot = TerminalV2XtermRendererSlot & {
  slotElement: HTMLElement;
  setAppearance(appearance: TerminalV2PooledRendererAppearance): void;
  dispose(): void;
};

export function createTerminalV2PooledDomSlot({
  slotId,
  parkingContainer,
  resolvePaneContainer,
  createRenderer,
  writePaneInput,
  onFitGeometry,
}: TerminalV2PooledDomSlotOptions): TerminalV2PooledDomSlot {
  const slotElement = document.createElement("div");
  slotElement.dataset.terminalV2SlotId = slotId;
  slotElement.className = "terminal-v2-pooled-renderer-slot";
  slotElement.style.position = "absolute";
  slotElement.style.inset = "0";
  slotElement.style.width = "100%";
  slotElement.style.height = "100%";
  slotElement.style.zIndex = "2";
  slotElement.style.background = "var(--cs-terminal-bg)";
  slotElement.style.overflow = "hidden";
  slotElement.style.contain = "layout paint size";
  slotElement.style.visibility = "hidden";
  slotElement.hidden = true;
  parkingContainer.appendChild(slotElement);

  const renderer = createRenderer(slotElement, slotId);
  let attachedPaneId: string | null = null;
  let lastAttachedAt = 0;
  let lastRenderAt = 0;
  let lastWriteAt = 0;
  let liveResizeActive = false;
  let pendingLiveResizeFit = false;
  let inputDisposable: TerminalV2PooledRendererInputDisposable | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let attachFitFrame: number | null = null;
  const renderDisposable = renderer.onRender?.(() => {
    lastRenderAt = Date.now();
  }) ?? null;

  const blurRenderer = () => {
    renderer.terminal.blur?.();
    renderer.helperTextarea?.blur();
    return Boolean(attachedPaneId);
  };

  const terminal = {
    reset: () => renderer.terminal.reset(),
    write: (data: string) => {
      lastWriteAt = Date.now();
      renderer.terminal.write(data);
    },
    refresh: (start: number, end: number) => renderer.terminal.refresh(start, end),
    get cols() {
      return renderer.terminal.cols;
    },
    get rows() {
      return renderer.terminal.rows;
    },
  };

  const disposeInput = () => {
    inputDisposable?.dispose();
    inputDisposable = null;
  };

  const cancelAttachFit = () => {
    if (attachFitFrame === null) return;
    cancelAnimationFrame(attachFitFrame);
    attachFitFrame = null;
  };

  const disposeResizeObserver = () => {
    resizeObserver?.disconnect();
    resizeObserver = null;
  };

  const fitAttachedPane = () => {
    const paneId = attachedPaneId;
    if (!paneId) return;
    if (liveResizeActive) {
      pendingLiveResizeFit = true;
      return;
    }
    pendingLiveResizeFit = false;
    renderer.fitAddon.fit();
    const { cols, rows } = renderer.terminal;
    if (Number.isFinite(cols) && Number.isFinite(rows) && cols && rows > 0) {
      onFitGeometry?.(paneId, cols, rows);
    }
  };

  const scheduleAttachFit = () => {
    cancelAttachFit();
    attachFitFrame = requestAnimationFrame(() => {
      attachFitFrame = null;
      fitAttachedPane();
      // Visibility is announced AFTER the fit, not before: an accelerated renderer allocates its
      // buffer at the canvas size it finds, and announcing it while the slot is still at the
      // parking container's size buys a GPU buffer for the wrong geometry.
      if (attachedPaneId) renderer.setVisible?.(true);
    });
  };

  const observePaneResize = (paneContainer: HTMLElement) => {
    disposeResizeObserver();
    if (typeof ResizeObserver === "undefined") return;
    resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || entry.contentRect.width <= 0 || entry.contentRect.height <= 0) return;
      fitAttachedPane();
    });
    resizeObserver.observe(paneContainer);
  };

  return {
    slotElement,
    terminal,
    fitAddon: renderer.fitAddon,
    liveOutputMode: "managed",
    attachPane(paneId) {
      const paneContainer = resolvePaneContainer(paneId);
      if (!paneContainer) return;
      attachedPaneId = paneId;
      lastAttachedAt = Date.now();
      slotElement.dataset.terminalV2PaneId = paneId;
      slotElement.hidden = false;
      slotElement.style.visibility = "visible";
      paneContainer.appendChild(slotElement);
      observePaneResize(paneContainer);
      scheduleAttachFit();
      disposeInput();
      if (writePaneInput && renderer.onData) {
        inputDisposable = renderer.onData((data) => writePaneInput(paneId, data));
      }
    },
    releasePane() {
      // Told before the element moves: a renderer giving a GPU context back wants to do it while
      // its canvas is still the one on screen, not after it has been re-parented.
      renderer.setVisible?.(false);
      attachedPaneId = null;
      disposeInput();
      cancelAttachFit();
      disposeResizeObserver();
      delete slotElement.dataset.terminalV2PaneId;
      slotElement.style.visibility = "hidden";
      slotElement.hidden = true;
      parkingContainer.appendChild(slotElement);
    },
    captureSnapshot: renderer.captureSnapshot,
    search: renderer.search,
    focus: () => {
      if (!attachedPaneId || !renderer.terminal.focus) return false;
      renderer.terminal.focus();
      return true;
    },
    blur: blurRenderer,
    getHelperTextarea: () => renderer.helperTextarea ?? null,
    setLiveResizeActive: (active) => {
      const wasLiveResizing = liveResizeActive;
      liveResizeActive = active;
      if (wasLiveResizing && !active && pendingLiveResizeFit) {
        fitAttachedPane();
      }
    },
    setAppearance(appearance) {
      renderer.setAppearance?.(appearance);
      // A new font size changes how many cells fit; the PTY has to follow.
      if (appearance.fontSize !== undefined) fitAttachedPane();
    },
    getHealth: () => ({
      attachedPaneId,
      lastAttachedAt,
      lastRenderAt,
      lastWriteAt,
      renderObserverAttached: Boolean(renderer.onRender),
    }),
    dispose() {
      disposeInput();
      cancelAttachFit();
      disposeResizeObserver();
      renderDisposable?.dispose();
      slotElement.remove();
      renderer.dispose();
    },
  };
}
