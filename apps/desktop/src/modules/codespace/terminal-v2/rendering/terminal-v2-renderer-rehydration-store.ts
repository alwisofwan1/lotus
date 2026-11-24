import { TerminalV2OutputRing, type TerminalV2OutputRingOptions } from "../output/terminal-v2-output-ring";

export type TerminalV2RendererRehydrationStoreOptions = {
  outputRingOptions?: TerminalV2OutputRingOptions;
};

export class TerminalV2RendererRehydrationStore {
  private readonly rings = new Map<string, TerminalV2OutputRing>();

  constructor(private readonly options: TerminalV2RendererRehydrationStoreOptions = {}) {}

  appendPaneOutput(paneId: string, data: string): void {
    if (!data) return;
    this.getRing(paneId).append(data);
  }

  drainPaneOutput(paneId: string, write: (chunk: string) => void): void {
    const ring = this.rings.get(paneId);
    if (!ring) return;
    ring.drain(write);
    if (!ring.hasData()) {
      this.rings.delete(paneId);
    }
  }

  hasPaneOutput(paneId: string): boolean {
    return this.rings.get(paneId)?.hasData() ?? false;
  }

  clearPane(paneId: string): void {
    this.rings.delete(paneId);
  }

  private getRing(paneId: string): TerminalV2OutputRing {
    const existing = this.rings.get(paneId);
    if (existing) return existing;
    const next = new TerminalV2OutputRing(this.options.outputRingOptions);
    this.rings.set(paneId, next);
    return next;
  }
}
