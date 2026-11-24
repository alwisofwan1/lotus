import type { SshTarget } from "@/modules/codespace/services/ssh-command";

/**
 * "Open a terminal pane running this sign-in command", from a surface that does not own the grid
 * (Settings, the usage popover). The Code shell answers it; with no listener the caller shows the
 * command to copy instead (plans/portable-accounts/issues/02, 05).
 */
type Listener = (command: string, target: string | null) => boolean;
const listeners = new Set<Listener>();

/** True when a pane was opened. `target`: the machine to run it on (`sshKey`), null for this Mac. */
export function requestSignInPane(command: string, target: string | null = null): boolean {
  for (const listener of listeners) if (listener(command, target)) return true;
  return false;
}

export function onSignInPaneRequest(handler: Listener): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}

/** The key `usage_remote` reports for a machine: `user@host:port`, host lowercased (Rust `TransportKey`). */
export function sshKey(t: SshTarget): string {
  const user = t.user?.trim();
  return `${user ? `${user}@` : ""}${t.host.trim().toLowerCase()}${t.port ? `:${t.port}` : ""}`;
}

export interface SignInWorkspace {
  id: string;
  /** `sshKey` of its machine; absent for this Mac. */
  target?: string;
}

/** Where a sign-in pane goes: the active workspace when it is on that machine, else the first one there. */
export function pickSignInWorkspace(workspaces: SignInWorkspace[], active: string | null, target: string | null): string | null {
  const on = (w: SignInWorkspace | undefined) => !!w && (w.target ?? null) === target;
  const current = workspaces.find((w) => w.id === active);
  return on(current) ? current!.id : (workspaces.find(on)?.id ?? null);
}
