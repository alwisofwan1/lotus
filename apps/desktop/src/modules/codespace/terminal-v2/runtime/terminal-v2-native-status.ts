import type { TerminalRuntimeStatus } from "@/modules/codespace/services/terminal-session-registry";

export type TerminalV2NativeStatusNotifier = {
  notify(status: TerminalRuntimeStatus): boolean;
  getLastStatus(): TerminalRuntimeStatus | null;
};

export type TerminalV2NativeStatusNotifierOptions = {
  initialStatus?: TerminalRuntimeStatus | null;
  onStatusChange?: (status: TerminalRuntimeStatus) => void;
};

export function createTerminalV2NativeStatusNotifier({
  initialStatus = null,
  onStatusChange,
}: TerminalV2NativeStatusNotifierOptions): TerminalV2NativeStatusNotifier {
  let lastStatus = initialStatus;

  return {
    notify(status) {
      if (lastStatus === status) return false;
      lastStatus = status;
      onStatusChange?.(status);
      return true;
    },
    getLastStatus() {
      return lastStatus;
    },
  };
}
