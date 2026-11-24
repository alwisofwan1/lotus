import {
  extractSubmittedTerminalPrompt,
  type TerminalInputMetadata,
} from "@/modules/codespace/services/terminal-input-events";
import { reduceInlineTerminalInput } from "@/modules/codespace/services/terminal-inline-suggestions";
import { getSuggestionRemainder } from "@/modules/codespace/services/terminal-suggestions";

export type TerminalV2InputWriteRequest = {
  data: string;
  metadata: TerminalInputMetadata;
};

export type TerminalV2InputEventRequest = {
  currentInput: string;
  data: string;
  history: string[];
  cwd: string;
  agentCommand?: string;
};

export type TerminalV2InputEventResult = {
  nextInput: string;
  suggestionRemainder: string;
  submittedPrompt: string;
  writeRequest: TerminalV2InputWriteRequest | null;
  /** @deprecated CWD updates come from shell-integration OSC output. */
  cwdProbeCommand?: string | null;
};

function createWriteRequest(
  data: string,
  submittedPrompt: string,
  agentCommand?: string,
): TerminalV2InputWriteRequest | null {
  if (!data) return null;

  return {
    data,
    metadata: {
      origin: "human",
      intent: submittedPrompt && agentCommand?.trim()
        ? "conversation-prompt"
        : "unknown",
      submitted: Boolean(submittedPrompt),
      promptText: submittedPrompt || undefined,
    },
  };
}

export function processTerminalV2InputEvent({
  currentInput,
  data,
  history,
  cwd,
  agentCommand,
}: TerminalV2InputEventRequest): TerminalV2InputEventResult {
  const normalizedData = normalizeTerminalV2InputData(data);
  const reduced = reduceInlineTerminalInput(currentInput, normalizedData, history, cwd);
  const submittedPrompt = extractSubmittedTerminalPrompt(normalizedData, currentInput);
  const suggestionRemainder = reduced.suggestion
    ? getSuggestionRemainder(reduced.nextInput, reduced.suggestion.command)
    : "";

  return {
    nextInput: reduced.nextInput,
    suggestionRemainder,
    submittedPrompt,
    writeRequest: createWriteRequest(reduced.writeData, submittedPrompt, agentCommand),
    // Shell integration emits cwd OSC markers from its prompt hook. Sending a
    // second command through the PTY makes that implementation detail visible.
    cwdProbeCommand: null,
  };
}

export function normalizeTerminalV2InputData(data: string): string {
  return data === "\r\n" ? "\r" : data;
}
