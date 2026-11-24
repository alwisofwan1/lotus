import type { TerminalInputMetadata } from "@/modules/codespace/services/terminal-input-events";

export type TerminalV2NativeInitialCommandWriter = (
  paneId: string,
  data: string,
  metadata: TerminalInputMetadata,
) => void;

export type SendTerminalV2NativeInitialCommandOptions = {
  created: boolean;
  initialCommand?: string | null;
  paneId: string;
  sentKeys: Set<string>;
  terminalCommand?: string[];
  write?: TerminalV2NativeInitialCommandWriter;
};

const INITIAL_COMMAND_METADATA: TerminalInputMetadata = {
  origin: "system",
  intent: "initial-command",
  submitted: false,
};

export function normalizeTerminalV2NativeInitialCommand(command?: string | null): string | null {
  if (!command) return null;
  return command.endsWith("\r") ? command : `${command}\r`;
}

export function sendTerminalV2NativeInitialCommand({
  created,
  initialCommand,
  paneId,
  sentKeys,
  terminalCommand,
  write,
}: SendTerminalV2NativeInitialCommandOptions): boolean {
  if (!created || terminalCommand?.length) return false;
  const normalizedCommand = normalizeTerminalV2NativeInitialCommand(initialCommand);
  if (!normalizedCommand) return false;

  const commandKey = `${paneId}:${normalizedCommand}`;
  if (sentKeys.has(commandKey)) return false;

  sentKeys.add(commandKey);
  write?.(paneId, normalizedCommand, INITIAL_COMMAND_METADATA);
  return true;
}
