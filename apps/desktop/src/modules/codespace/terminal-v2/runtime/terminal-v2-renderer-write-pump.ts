import type { TerminalWriteScheduler } from "@/modules/codespace/services/terminal-write-scheduler";
import { createTerminalV2WriteScheduler } from "../output/terminal-v2-write-scheduler-adapter";

export type TerminalV2RendererWritePumpOptions = {
  /** Writes into the pane's currently leased renderer slot; false when the lease is gone. */
  writeToPane(paneId: string, data: string): boolean;
  /** Keeps output for a pane that has no renderer, so a later rebind can replay it. */
  appendBacklog(paneId: string, data: string): void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
};

/**
 * Coalesces live PTY output per pane into one renderer write per frame.
 *
 * Without this every PTY chunk becomes its own xterm write on the renderer the user is looking at,
 * which is what makes bursty output (build logs, agent streaming) expensive. The lease is resolved
 * at flush time rather than at push time, and callers flush whenever a pane's renderer lease
 * changes, so a batch can never land in a slot that has moved on to another pane.
 */
export class TerminalV2RendererWritePump {
  private readonly schedulers = new Map<string, TerminalWriteScheduler>();

  constructor(private readonly options: TerminalV2RendererWritePumpOptions) {}

  push(paneId: string, data: string): void {
    this.getScheduler(paneId).push(data);
  }

  flush(paneId: string): void {
    this.schedulers.get(paneId)?.flush();
  }

  dispose(paneId: string): void {
    const scheduler = this.schedulers.get(paneId);
    if (!scheduler) return;
    this.schedulers.delete(paneId);
    scheduler.dispose();
  }

  disposeAll(): void {
    for (const paneId of Array.from(this.schedulers.keys())) this.dispose(paneId);
  }

  private getScheduler(paneId: string): TerminalWriteScheduler {
    const existing = this.schedulers.get(paneId);
    if (existing) return existing;
    const scheduler = createTerminalV2WriteScheduler({
      paneId,
      write: (data, callback) => {
        if (!this.options.writeToPane(paneId, data)) {
          this.options.appendBacklog(paneId, data);
        }
        callback();
      },
      // xterm schedules its own render for each write; an extra refresh per frame is wasted paint.
      refresh: () => undefined,
      ...(this.options.requestFrame ? { requestFrame: this.options.requestFrame } : {}),
      ...(this.options.cancelFrame ? { cancelFrame: this.options.cancelFrame } : {}),
    });
    this.schedulers.set(paneId, scheduler);
    return scheduler;
  }
}
