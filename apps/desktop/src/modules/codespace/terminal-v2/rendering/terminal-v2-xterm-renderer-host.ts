import type { TerminalSearchMode } from "@/modules/codespace/services/terminal-search-options";
import type { TerminalV2RendererHost } from "./terminal-v2-renderer-adapter";

export type TerminalV2PaneSearchApi = {
  findNext(query: string, mode?: TerminalSearchMode): boolean;
  findPrevious(query: string): boolean;
  clearSearch(): void;
};

export type TerminalV2XtermLike = {
  reset(): void;
  write(data: string): void;
  refresh(start: number, end: number): void;
  focus?(): void;
  blur?(): void;
  cols?: number;
  rows: number;
};

export type TerminalV2FitAddonLike = {
  fit(): void;
};

export type TerminalV2RendererSlotHealth = {
  attachedPaneId: string | null;
  lastAttachedAt: number;
  lastRenderAt: number;
  lastWriteAt: number;
  renderObserverAttached: boolean;
};

export type TerminalV2XtermRendererSlot = {
  terminal: TerminalV2XtermLike;
  fitAddon: TerminalV2FitAddonLike;
  liveOutputMode?: "managed" | "external";
  attachPane(paneId: string): void;
  releasePane(paneId: string, snapshot: string | null): void;
  captureSnapshot?(): string | null;
  getHealth?(): TerminalV2RendererSlotHealth;
  getHelperTextarea?(): HTMLTextAreaElement | null;
  focus?(): boolean;
  blur?(): boolean;
  setLiveResizeActive?(active: boolean): void;
  search?: TerminalV2PaneSearchApi;
};

export type TerminalV2XtermRendererHostOptions = {
  createSlot(slotId: string): TerminalV2XtermRendererSlot;
  drainPaneOutput(paneId: string, write: (chunk: string) => void): void;
  onFitGeometry?(paneId: string, cols: number, rows: number): void;
};

export class TerminalV2XtermRendererHost implements TerminalV2RendererHost {
  private readonly slots = new Map<string, TerminalV2XtermRendererSlot>();
  private readonly createdSlotIds = new Set<string>();

  constructor(private readonly options: TerminalV2XtermRendererHostOptions) {}

  registerSlot(slotId: string, slot: TerminalV2XtermRendererSlot): () => void {
    this.slots.set(slotId, slot);
    this.createdSlotIds.delete(slotId);
    return () => {
      if (this.slots.get(slotId) === slot) {
        this.slots.delete(slotId);
      }
    };
  }

  /**
   * Drops the slots this host created itself, for when the factory behind them is going away.
   * Otherwise a slot id leased again later resolves to the old, disposed slot.
   */
  forgetCreatedSlots(): void {
    for (const slotId of this.createdSlotIds) this.slots.delete(slotId);
    this.createdSlotIds.clear();
  }

  attachSlot(slotId: string, paneId: string): void {
    this.getSlot(slotId).attachPane(paneId);
  }

  resetSlot(slotId: string): void {
    this.getSlot(slotId).terminal.reset();
  }

  writeToSlot(slotId: string, data: string): void {
    this.getSlot(slotId).terminal.write(data);
  }

  drainPaneOutput(paneId: string, write: (chunk: string) => void): void {
    this.options.drainPaneOutput(paneId, write);
  }

  fitSlot(slotId: string, paneId: string): void {
    const slot = this.getSlot(slotId);
    slot.fitAddon.fit();
    const { cols, rows } = slot.terminal;
    if (Number.isFinite(cols) && Number.isFinite(rows) && cols && rows > 0) {
      this.options.onFitGeometry?.(paneId, cols, rows);
    }
  }

  repaintSlot(slotId: string, paneId: string): void {
    void paneId;
    const terminal = this.getSlot(slotId).terminal;
    if (terminal.rows <= 0) return;
    terminal.refresh(0, terminal.rows - 1);
  }

  releaseSlot(slotId: string, paneId: string, snapshot: string | null): void {
    this.getSlot(slotId).releasePane(paneId, snapshot);
  }

  captureSlotSnapshot(slotId: string, paneId: string): string | null {
    void paneId;
    try {
      return this.getSlot(slotId).captureSnapshot?.() ?? null;
    } catch {
      // A snapshot is scrollback we would LIKE to keep, never something teardown depends on.
      // Releasing a pane whose xterm is already disposed makes the serialize addon throw while
      // reading its buffer (observed 2026-09-20 on every pane release), and that exception
      // escaped through the renderer lifecycle's cleanup effect. No snapshot is a fine answer;
      // a thrown one leaves the slot half-released.
      return null;
    }
  }

  getSlotHealth(slotId: string, paneId: string): TerminalV2RendererSlotHealth | null {
    void paneId;
    return this.getSlot(slotId).getHealth?.() ?? null;
  }

  getSlotSearchApi(slotId: string, paneId: string): TerminalV2PaneSearchApi | null {
    void paneId;
    return this.getSlot(slotId).search ?? null;
  }

  getSlotHelperTextarea(slotId: string, paneId: string): HTMLTextAreaElement | null {
    void paneId;
    return this.getSlot(slotId).getHelperTextarea?.() ?? null;
  }

  focusSlot(slotId: string, paneId: string): boolean {
    void paneId;
    return this.getSlot(slotId).focus?.() ?? false;
  }

  blurSlot(slotId: string, paneId: string): boolean {
    void paneId;
    return this.getSlot(slotId).blur?.() ?? false;
  }

  setSlotLiveResizeActive(slotId: string, paneId: string, active: boolean): void {
    void paneId;
    this.getSlot(slotId).setLiveResizeActive?.(active);
  }

  private getSlot(slotId: string): TerminalV2XtermRendererSlot {
    const existing = this.slots.get(slotId);
    if (existing) return existing;
    const next = this.options.createSlot(slotId);
    this.slots.set(slotId, next);
    this.createdSlotIds.add(slotId);
    return next;
  }
}
