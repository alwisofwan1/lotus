import { listen } from "@tauri-apps/api/event";
import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";

/**
 * A remote pane's link to its machine's session daemon (plans/ssh-pane-durability, phase 3),
 * as `pty-link` reports it from `sessiond_client`.
 *
 * - `reconnecting`: the link dropped; the process still runs on the machine.
 * - `needs-sign-in`: the last try failed on an expired Cloudflare Access sign-in.
 * - `connected`: back, with every byte of output caught up.
 */
export type PtyLinkState = "connected" | "reconnecting" | "needs-sign-in";

export type PtyLinkEvent = {
  sessionIds: string[];
  state: PtyLinkState;
  attempt?: number;
  nextInMs?: number;
};

type Listener = (event: PtyLinkEvent) => void;

const listeners = new Map<string, Set<Listener>>();
let started: Promise<unknown> | null = null;

/** Every pane shares one `pty-link` listener; it lives as long as the page. */
function ensureListening(): void {
  if (started || !isTauri()) return;
  started = listen<PtyLinkEvent>("pty-link", (event) => dispatchPtyLink(event.payload)).catch((error) => {
    started = null;
    console.warn("[pty-link] could not listen:", error);
  });
}

/** Hands an event to the panes it names. Exported for tests. */
export function dispatchPtyLink(event: PtyLinkEvent): void {
  for (const id of event.sessionIds) {
    for (const listener of listeners.get(id) ?? []) listener(event);
  }
}

/** Calls `onEvent` for each link change of PTY session `sessionId` until the returned stop. */
export function subscribePtyLink(sessionId: string, onEvent: Listener): () => void {
  ensureListening();
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(onEvent);
  return () => {
    set.delete(onEvent);
    if (set.size === 0) listeners.delete(sessionId);
  };
}

/** "Retry now": cuts the reconnect wait of this session's machine short. */
export function retrySessionLink(sessionId: string): Promise<boolean> {
  return tauriInvoke<boolean>("retry_session_link", { sessionId });
}

/** Opens the Cloudflare Access sign-in for this session's machine; the link retries once saved. */
export function signInSessionLink(sessionId: string): Promise<string | null> {
  return tauriInvoke<string | null>("sign_in_session_link", { sessionId });
}
