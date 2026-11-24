import type { TerminalRuntimeStatus } from "@/modules/codespace/services/terminal-session-registry";
import type { processTerminalV2OutputEvent } from "../output/terminal-v2-output-event-adapter";

export type TerminalV2NativeOutputScheduler = {
  push(data: string): void;
  flush(): void;
};

/**
 * Where output goes while a different renderer (a pooled slot) is the one the user actually sees.
 * The native xterm then stays a cold standby: it stops parsing every byte — which is the whole cost
 * of keeping it around — and the bytes are kept in the pane's bounded rehydration ring so a
 * fallback rebind can replay them.
 */
export type TerminalV2NativeOutputStandbyBacklog = {
  isActive(): boolean;
  append(data: string): void;
};

export type TerminalV2NativeOutputHandlerOptions = {
  cwd: string;
  onCurrentDirectoryChange?: (cwd: string) => void;
  notifyRuntimeStatus?: (status: TerminalRuntimeStatus) => void;
  onExit?: (code: number) => void;
  onRuntimeSessionIdChange?: (sessionId: string | null) => void;
  noteOutputChunk?: (visibleData: string) => void;
  processOutput?: typeof processTerminalV2OutputEvent;
  scheduler?: TerminalV2NativeOutputScheduler;
  setLive?: (live: boolean) => void;
  standbyBacklog?: TerminalV2NativeOutputStandbyBacklog;
};

export type TerminalV2NativeOutputHandler = {
  handleOutput(data: string): void;
};

export function createTerminalV2NativeOutputHandler({
  cwd,
  onCurrentDirectoryChange,
  notifyRuntimeStatus,
  onExit,
  onRuntimeSessionIdChange,
  noteOutputChunk,
  processOutput,
  scheduler,
  setLive,
  standbyBacklog,
}: TerminalV2NativeOutputHandlerOptions): TerminalV2NativeOutputHandler {
  return {
    handleOutput(data) {
      const result = processOutput?.({
        data,
        paneRuntimeState: "ready_visible",
        trustPromptSeen: false,
        cwd,
        cwdTrusted: false,
        hasActiveSuggestionRemainder: false,
      });
      result?.cwdUpdates.forEach((nextCwd) => onCurrentDirectoryChange?.(nextCwd));
      const exitCode = result?.exitCode;
      const isExit = exitCode !== null && exitCode !== undefined;
      const output = result
        ? (result.visibleData || (isExit ? `\r\n\x1b[2m[session exited ${exitCode}]\x1b[0m\r\n` : ""))
        : (isExit ? `\r\n\x1b[2m[session exited ${exitCode}]\x1b[0m\r\n` : data);
      if (output) {
        noteOutputChunk?.(output);
        if (standbyBacklog?.isActive()) {
          standbyBacklog.append(output);
        } else {
          // push() alone coalesces chunks into one write per frame. An immediate flush() here
          // turned every PTY chunk (up to 250/s per agent) into its own write + full refresh.
          // Exit still flushes: the exit callbacks below may tear the scheduler down.
          scheduler?.push(output);
          if (isExit) scheduler?.flush();
        }
      }
      if (isExit) {
        setLive?.(false);
        onRuntimeSessionIdChange?.(null);
        notifyRuntimeStatus?.("exited");
        onExit?.(exitCode);
      }
    },
  };
}
