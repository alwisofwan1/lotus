/**
 * The PTY sessions that run as a plain `ssh -t` to another machine, and which machine.
 *
 * Such a pane dies with its link. Once that machine has a Lotus host, the pane can be opened again
 * inside the host's session daemon (plans/ssh-pane-durability, phase 5). Session ids are unique per
 * run, so an entry is never reused and never needs to be removed.
 */
import { useSyncExternalStore } from "react";
import type { SshTarget } from "@/modules/codespace/services/ssh-command";

const machines = new Map<string, SshTarget>();
const listeners = new Set<() => void>();

export function markPlainSshSession(sessionId: string, machine: SshTarget): void {
  if (machines.get(sessionId) === machine) return;
  machines.set(sessionId, machine);
  for (const fn of listeners) fn();
}

export function plainSshMachine(sessionId: string | null | undefined): SshTarget | null {
  return sessionId ? machines.get(sessionId) ?? null : null;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The machine of a plain `ssh -t` session, or null for a local or daemon-backed one. */
export function usePlainSshMachine(sessionId: string | null | undefined): SshTarget | null {
  return useSyncExternalStore(subscribe, () => plainSshMachine(sessionId), () => null);
}

/** Tests only. */
export function resetPlainSshSessionsForTest(): void {
  machines.clear();
}
