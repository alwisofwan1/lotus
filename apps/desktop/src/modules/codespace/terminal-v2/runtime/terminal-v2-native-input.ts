import type { TerminalInputMetadata } from "@/modules/codespace/services/terminal-input-events";
import { processTerminalV2InputEvent } from "../input/terminal-v2-input-event-adapter";

export type TerminalV2NativeInputSessionWriter = {
  write(paneId: string, data: string, metadata?: TerminalInputMetadata): void;
};

export type TerminalV2NativeSuggestionAdapter = {
  remainderChanged(remainder: string): void;
  layoutChanged(): void;
};

export type TerminalV2NativeInputHandlerOptions = {
  agentCommand?: string;
  cwd: string;
  history: string[];
  noteUserInput: (paneId: string, hint?: { data?: string; submitted?: boolean; agentTurnCandidate?: boolean }) => void;
  onInlineCommandSubmit?: (command: string) => void;
  paneId: string;
  processInput?: typeof processTerminalV2InputEvent;
  sessionWriter?: TerminalV2NativeInputSessionWriter;
  suggestionAdapter?: TerminalV2NativeSuggestionAdapter;
};

export type TerminalV2NativeInputHandler = {
  handleInput(data: string): void;
  dispose(): void;
};

export function createTerminalV2NativeInputHandler({
  agentCommand,
  cwd,
  history,
  noteUserInput,
  onInlineCommandSubmit,
  paneId,
  processInput = processTerminalV2InputEvent,
  sessionWriter,
  suggestionAdapter,
}: TerminalV2NativeInputHandlerOptions): TerminalV2NativeInputHandler {
  let currentInput = "";
  let disposed = false;

  return {
    handleInput(data) {
      if (disposed) return;
      const result = processInput({ currentInput, data, history, cwd, agentCommand });
      currentInput = result.nextInput;
      suggestionAdapter?.remainderChanged(result.suggestionRemainder);
      if (result.submittedPrompt) onInlineCommandSubmit?.(result.submittedPrompt);
      if (result.writeRequest) {
        noteUserInput(paneId, {
          agentTurnCandidate: Boolean(agentCommand),
          data: result.writeRequest.data,
          submitted: Boolean(result.writeRequest.metadata?.submitted),
        });
        sessionWriter?.write(paneId, result.writeRequest.data, result.writeRequest.metadata);
      }
      suggestionAdapter?.layoutChanged();
    },
    dispose() {
      disposed = true;
    },
  };
}
