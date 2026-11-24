export type TerminalInputOrigin =
  | "human"
  | "bridge"
  | "mcp"
  | "system"
  | "programmatic";

export type TerminalInputIntent =
  | "conversation-prompt"
  | "shell-command"
  | "control"
  | "initial-command"
  | "unknown";

export type TerminalInputMetadata = {
  origin: TerminalInputOrigin;
  intent: TerminalInputIntent;
  submitted: boolean;
  promptText?: string;
};

export type TerminalInputEvent = TerminalInputMetadata & {
  paneId: string;
  workspaceId: string;
  data: string;
};

export const DEFAULT_TERMINAL_INPUT_METADATA: TerminalInputMetadata = {
  origin: "programmatic",
  intent: "unknown",
  submitted: false,
};

export function extractSubmittedTerminalPrompt(
  data: string,
  previousInput: string,
): string {
  if (data === "\r" || data === "\n" || data === "\r\n") {
    return previousInput.trim();
  }

  const match = data.match(/^([\s\S]*?)(?:\r\n|\r|\n)/);
  return match ? `${previousInput}${match[1]}`.trim() : "";
}
