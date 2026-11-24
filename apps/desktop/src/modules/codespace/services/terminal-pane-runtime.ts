// Terminal Pane Runtime — see CONTEXT.md.
//
// Explicit state machine for terminal cell lifecycle. The pre-deepening
// implementation scattered readiness across closures: `runtimeStarted`,
// `termReady`, `disposed`, `activeRef.current`, `webglActivationInFlightRef`.
// Drain races, WebGL refresh misses, and reattach quirks all lived in those
// gaps. Concentrating the transitions here makes those bugs unrepresentable.

export type TerminalPaneState =
  | "uninitialized"
  | "initializing"
  | "xterm_created"
  | "ready_hidden"
  | "ready_visible"
  | "disposed";

export type TerminalPaneRenderer = "canvas" | "webgl_pending" | "webgl";

export interface TerminalPaneSnapshot {
  readonly state: TerminalPaneState;
  readonly renderer: TerminalPaneRenderer;
  readonly visibleIntent: boolean;
  /**
   * True while the user is actively dragging a grid pane border. Heavy work
   * (xterm fit, PTY SIGWINCH) is deferred until the drag commits. Drag is a
   * transient input mode — orthogonal to lifecycle state, hence a separate
   * field rather than a new state enum value.
   */
  readonly liveResizeActive: boolean;
}

export interface TerminalPaneHost {
  /**
   * Drain accumulated hidden-buffer content by streaming each block to `write`.
   * Called with zero chunks when the buffer is empty.
   */
  drainHiddenBuffer(write: (chunk: string) => void): void;
  /** Write a chunk to the live xterm via the configured write scheduler. */
  writeToTerminal(data: string): void;
  /** Force a full viewport repaint (rows 0 .. rows-1). Called after renderer promotions and after drain on becoming visible. */
  refreshViewport(): void;
  /** Tear down xterm, addons, and any owned resources. Idempotent. */
  disposeTerminal(): void;
  /**
   * Run a single authoritative fit() + immediate SIGWINCH after a drag
   * commits. Bypasses any debounce so the user sees the final geometry as
   * soon as they release the pane handle.
   */
  commitFit(): void;
}

export interface TerminalPaneRuntimeOptions {
  readonly initiallyVisible: boolean;
}

export type TerminalPaneListener = (snapshot: TerminalPaneSnapshot) => void;

const READY_STATES: ReadonlySet<TerminalPaneState> = new Set(["ready_hidden", "ready_visible"]);

export class TerminalPaneRuntime {
  private state: TerminalPaneState = "uninitialized";
  private renderer: TerminalPaneRenderer = "canvas";
  private visibleIntent: boolean;
  private liveResizeActive = false;
  private listeners = new Set<TerminalPaneListener>();

  constructor(private readonly host: TerminalPaneHost, options: TerminalPaneRuntimeOptions) {
    this.visibleIntent = options.initiallyVisible;
  }

  getSnapshot(): TerminalPaneSnapshot {
    return {
      state: this.state,
      renderer: this.renderer,
      visibleIntent: this.visibleIntent,
      liveResizeActive: this.liveResizeActive,
    };
  }

  isLiveResizing(): boolean {
    return this.liveResizeActive;
  }

  subscribe(listener: TerminalPaneListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Begin async initialization (font load, xterm dynamic import). */
  init(): void {
    if (this.state !== "uninitialized") return;
    this.transition("initializing");
  }

  /** Signal that the xterm constructor has resolved and the instance is live. */
  notifyXtermCreated(): void {
    if (this.state !== "initializing") return;
    this.transition("xterm_created");
  }

  /**
   * Signal that geometry has been measured AND the PTY session is attached.
   * Bundled to match the current code path where attachment is gated on a
   * valid first ResizeObserver dimension; the state machine doesn't need to
   * carry both flags when callers can only invoke this once both are true.
   */
  notifyAttached(): void {
    if (this.state !== "xterm_created") return;
    this.transition(this.visibleIntent ? "ready_visible" : "ready_hidden");
  }

  /** Set the desired visibility intent. Applies immediately if in a ready state, otherwise queued. */
  setVisible(visible: boolean): void {
    if (this.visibleIntent === visible) return;
    this.visibleIntent = visible;
    if (this.state === "ready_hidden" && visible) {
      this.transition("ready_visible");
    } else if (this.state === "ready_visible" && !visible) {
      this.transition("ready_hidden");
    } else {
      // Intent recorded; will apply on next eligible transition.
      this.emit();
    }
  }

  /** Renderer is starting async promotion (e.g. WebGL addon loading). */
  notifyRendererPromoting(): void {
    if (!READY_STATES.has(this.state)) return;
    if (this.renderer !== "canvas") return;
    this.renderer = "webgl_pending";
    this.emit();
  }

  /** Renderer promotion succeeded; force a full repaint so content drawn on the prior renderer is visible. */
  notifyRendererPromoted(): void {
    if (this.renderer !== "webgl_pending") return;
    this.renderer = "webgl";
    if (this.state === "ready_visible") {
      this.host.refreshViewport();
    }
    this.emit();
  }

  /** Renderer promotion failed; stay on canvas. */
  notifyRendererPromotionFailed(): void {
    if (this.renderer !== "webgl_pending") return;
    this.renderer = "canvas";
    this.emit();
  }

  /**
   * Intentional renderer rollback (focus loss, hidden pane, live resize). If
   * content was already painted by WebGL, repaint through the fallback canvas
   * renderer so the viewport does not keep stale GPU pixels.
   */
  notifyRendererDemoted(): void {
    const wasFullyOnWebgl = this.renderer === "webgl";
    if (this.renderer !== "webgl" && this.renderer !== "webgl_pending") return;
    this.renderer = "canvas";
    if (wasFullyOnWebgl && this.state === "ready_visible") {
      this.host.refreshViewport();
    }
    this.emit();
  }

  /**
   * Post-success WebGL failure (e.g. GPU context loss after fullscreen / large
   * resize). Distinct from promotion failure: content was being painted on
   * WebGL, so the fallback renderer needs a forced repaint to avoid a frozen
   * viewport.
   */
  notifyRendererLost(): void {
    const wasFullyOnWebgl = this.renderer === "webgl";
    if (this.renderer !== "webgl" && this.renderer !== "webgl_pending") return;
    this.renderer = "canvas";
    // Only force a repaint if content was actually being painted via WebGL.
    // Loss from `webgl_pending` means the addon died before attaching — xterm
    // was still using the default renderer, so existing pixels are valid.
    if (wasFullyOnWebgl && this.state === "ready_visible") {
      this.host.refreshViewport();
    }
    this.emit();
  }

  /**
   * Mark the cell as participating in an active grid-pane drag. While set,
   * heavy xterm/PTY work is gated by fallback runtime callers (see
   * useLegacyTerminalRuntime sendResize). Idempotent.
   */
  notifyLiveResizeStart(): void {
    if (this.state === "disposed") return;
    if (this.liveResizeActive) return;
    this.liveResizeActive = true;
    this.emit();
  }

  /**
   * Drag committed. Clear the flag and trigger a single authoritative fit +
   * SIGWINCH via the host so the final geometry is correct. No-op outside
   * ready states.
   */
  notifyLiveResizeEnd(): void {
    if (this.state === "disposed") return;
    if (!this.liveResizeActive) return;
    this.liveResizeActive = false;
    if (this.state === "ready_visible" || this.state === "ready_hidden") {
      this.host.commitFit();
    }
    this.emit();
  }

  /** Terminal state — cannot be re-entered. Subsequent events are silently ignored. */
  dispose(): void {
    if (this.state === "disposed") return;
    this.transition("disposed");
  }

  private transition(next: TerminalPaneState): void {
    this.state = next;
    this.runEntryAction(next);
    this.emit();
  }

  private runEntryAction(state: TerminalPaneState): void {
    if (state === "ready_visible") {
      this.host.drainHiddenBuffer((chunk) => this.host.writeToTerminal(chunk));
      this.host.refreshViewport();
    } else if (state === "disposed") {
      this.host.disposeTerminal();
    }
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
