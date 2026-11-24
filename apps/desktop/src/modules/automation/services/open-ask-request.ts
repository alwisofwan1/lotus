/**
 * A request to open Automation › Inbox on one Ask, from wherever Lotus heard it (the app frame,
 * which is always mounted) to the workspace shell (which may mount only after a trip Home).
 * `seq` grows with each request, so asking for the same Ask twice still counts.
 */
export type OpenAskRequest = { id: string; seq: number };

let current: OpenAskRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();

const changed = () => listeners.forEach((listener) => listener());

export function requestOpenAsk(id: string): void {
  seq += 1;
  current = { id, seq };
  changed();
}

/** Spent: the panel it opened has closed. */
export function clearOpenAskRequest(): void {
  if (current === null) return;
  current = null;
  changed();
}

export function openAskRequest(): OpenAskRequest | null {
  return current;
}

export function subscribeToOpenAskRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
