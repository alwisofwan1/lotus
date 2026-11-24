import type {
  TerminalV2RendererBindPlan,
  TerminalV2RendererReleasePlan,
} from "./terminal-v2-renderer-pool";

export type TerminalV2RendererHost = {
  attachSlot(slotId: string, paneId: string): void;
  resetSlot(slotId: string): void;
  writeToSlot(slotId: string, data: string): void;
  drainPaneOutput(paneId: string, write: (chunk: string) => void): void;
  fitSlot(slotId: string, paneId: string): void;
  repaintSlot(slotId: string, paneId: string): void;
  releaseSlot(slotId: string, paneId: string, snapshot: string | null): void;
};

export type TerminalV2RendererRestoreError = {
  paneId: string;
  slotId: string;
  error: unknown;
};

export type TerminalV2RendererAdapterOptions = {
  onRestoreError?: (error: TerminalV2RendererRestoreError) => void;
};

export class TerminalV2RendererAdapter {
  constructor(
    private readonly host: TerminalV2RendererHost,
    private readonly options: TerminalV2RendererAdapterOptions = {},
  ) {}

  applyBindPlan(plan: TerminalV2RendererBindPlan): void {
    if (plan.evicted) {
      this.host.releaseSlot(plan.evicted.slotId, plan.evicted.paneId, plan.evicted.snapshot);
    }

    this.host.attachSlot(plan.slotId, plan.paneId);

    if (plan.kind === "bound") {
      this.host.resetSlot(plan.slotId);
    }

    if (plan.restore.fit) {
      this.host.fitSlot(plan.slotId, plan.paneId);
    }

    if (plan.restore.snapshot) {
      try {
        this.host.writeToSlot(plan.slotId, plan.restore.snapshot);
      } catch (error) {
        this.options.onRestoreError?.({ paneId: plan.paneId, slotId: plan.slotId, error });
      }
    }

    if (plan.restore.drainOutput) {
      this.host.drainPaneOutput(plan.paneId, (chunk) => {
        this.host.writeToSlot(plan.slotId, chunk);
      });
    }

    if (plan.restore.repaint) {
      this.host.repaintSlot(plan.slotId, plan.paneId);
    }
  }

  applyReleasePlan(plan: TerminalV2RendererReleasePlan | null): void {
    if (!plan) return;
    this.host.releaseSlot(plan.slotId, plan.paneId, plan.snapshot);
  }
}
