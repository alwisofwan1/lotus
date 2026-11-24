import { TerminalV2RendererRehydrationStore } from "../rendering/terminal-v2-renderer-rehydration-store";

export type TerminalV2PaneBacklogsOptions = {
  /** True once a pane has been handed back from a pooled slot to its own renderer. */
  isPaneOnRegisteredSlotFallback(paneId: string): boolean;
};

/**
 * The two bounded output rings a pane can need, kept apart on purpose.
 *
 * - *missed*: output that arrived while the pane had no renderer at all (hidden workspace,
 *   renderer not yet bound). Replayed when any renderer binds.
 * - *standby*: output the pane's own renderer skipped while a pooled slot rendered the pane live.
 *   Replayed only when that renderer takes over.
 *
 * Draining the wrong one duplicates scrollback the visible renderer already showed, so the choice
 * is made here rather than at each call site.
 */
export class TerminalV2PaneBacklogs {
  private readonly missed = new TerminalV2RendererRehydrationStore();
  private readonly standby = new TerminalV2RendererRehydrationStore();

  constructor(private readonly options: TerminalV2PaneBacklogsOptions) {}

  appendMissedOutput(paneId: string, data: string): void {
    this.missed.appendPaneOutput(paneId, data);
  }

  appendStandbyOutput(paneId: string, data: string): void {
    this.standby.appendPaneOutput(paneId, data);
  }

  clearStandbyOutput(paneId: string): void {
    this.standby.clearPane(paneId);
  }

  drainForPane(paneId: string, write: (chunk: string) => void): void {
    if (this.options.isPaneOnRegisteredSlotFallback(paneId)) {
      this.standby.drainPaneOutput(paneId, write);
      return;
    }
    this.missed.drainPaneOutput(paneId, write);
  }

  clearPane(paneId: string): void {
    this.missed.clearPane(paneId);
    this.standby.clearPane(paneId);
  }
}
