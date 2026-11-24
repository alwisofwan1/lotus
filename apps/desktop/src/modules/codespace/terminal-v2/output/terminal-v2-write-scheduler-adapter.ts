import {
  createTerminalWriteScheduler,
  type TerminalWriteFn,
  type TerminalWriteScheduler,
} from "@/modules/codespace/services/terminal-write-scheduler";
import { createTerminalWriteMetricsObserver } from "@/modules/codespace/services/terminal-write-metrics";

export type TerminalV2WriteSchedulerFactoryOptions = {
  paneId: string;
  write: TerminalWriteFn;
  refresh: () => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
  maxPendingBytes?: number;
};

export type TerminalV2WriteSchedulerFactory = (
  options: TerminalV2WriteSchedulerFactoryOptions,
) => TerminalWriteScheduler;

const DEFAULT_TERMINAL_V2_MAX_PENDING_BYTES = 2 * 1024 * 1024;

export function createTerminalV2WriteScheduler({
  paneId,
  write,
  refresh,
  requestFrame,
  cancelFrame,
  maxPendingBytes = DEFAULT_TERMINAL_V2_MAX_PENDING_BYTES,
}: TerminalV2WriteSchedulerFactoryOptions): TerminalWriteScheduler {
  return createTerminalWriteScheduler({
    maxPendingBytes,
    metrics: createTerminalWriteMetricsObserver(paneId),
    write,
    refresh,
    requestFrame,
    cancelFrame,
  });
}
