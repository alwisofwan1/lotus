export const TERMINAL_LABEL_MAX_LENGTH = 64;

export interface TerminalIdentityInput {
  label?: unknown;
  terminalNumber?: unknown;
}

export function terminalDefaultName(terminalNumber: unknown): string {
  const number = typeof terminalNumber === "number" && Number.isFinite(terminalNumber)
    ? Math.max(1, Math.trunc(terminalNumber))
    : 1;
  return `Terminal ${number}`;
}

export function normalizeTerminalLabel(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, TERMINAL_LABEL_MAX_LENGTH) : "";
}

export function terminalDisplayName(input: TerminalIdentityInput): string {
  return normalizeTerminalLabel(input.label) || terminalDefaultName(input.terminalNumber);
}

export function terminalAliases(input: TerminalIdentityInput): string[] {
  const fallback = terminalDefaultName(input.terminalNumber);
  return fallback === terminalDisplayName(input) ? [] : [fallback];
}
