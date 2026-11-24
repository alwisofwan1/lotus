import {
  getSuggestionRemainder,
  getTerminalSuggestions,
  type TerminalSuggestion,
} from "@/modules/codespace/services/terminal-suggestions";

export interface InlineTerminalInputResult {
  intercepted: boolean;
  nextInput: string;
  suggestion: TerminalSuggestion | null;
  writeData: string;
}

function isPrintableInput(data: string): boolean {
  return data.length === 1 && data >= " " && data !== "\u007f";
}

function nextInputValue(currentInput: string, data: string): string {
  if (data === "\u0003" || data === "\u000c") {
    return "";
  }

  if (data === "\u007f") {
    return currentInput.slice(0, -1);
  }

  if (data.includes("\r") || data.includes("\n")) {
    const normalized = data.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return normalized.split("\n").at(-1) ?? "";
  }

  if (isPrintableInput(data)) {
    return `${currentInput}${data}`;
  }

  if (data.length > 1 && !/[\u0000-\u001f\u007f]/.test(data)) {
    return `${currentInput}${data}`;
  }

  return currentInput;
}

export function reduceInlineTerminalInput(
  currentInput: string,
  data: string,
  history: string[],
  cwd = "",
): InlineTerminalInputResult {
  const currentSuggestion = getTerminalSuggestions(currentInput, history, { cwd })[0] ?? null;

  if (data === "\t" && currentSuggestion) {
    return {
      intercepted: true,
      nextInput: currentSuggestion.command,
      suggestion: currentSuggestion,
      writeData: getSuggestionRemainder(currentInput, currentSuggestion.command),
    };
  }

  const nextInput = nextInputValue(currentInput, data);
  const nextSuggestion = getTerminalSuggestions(nextInput, history, { cwd })[0] ?? null;

  return {
    intercepted: false,
    nextInput,
    suggestion: nextSuggestion,
    writeData: data,
  };
}
