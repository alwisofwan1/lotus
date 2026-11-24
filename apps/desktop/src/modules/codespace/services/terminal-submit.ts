const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

export function encodeTerminalCommandSubmission(command: string): string {
  if (!command.includes("\n")) {
    return `${command}\r`;
  }

  return `${BRACKETED_PASTE_START}${command}${BRACKETED_PASTE_END}\r`;
}

export function encodeTerminalTextSubmission(text: string): string {
  return encodeTerminalCommandSubmission(text.replace(/(?:\r\n|\r|\n)$/, ""));
}
