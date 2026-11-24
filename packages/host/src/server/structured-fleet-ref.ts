import type { ChatActionResult, ConversationListener, ConversationPage, ConversationResume } from "../types/conversation.js";
import type { FleetMember } from "../types/fleet.js";

/**
 * A late-bound read of the cells the mobile adapter runs itself (`tui: false`).
 *
 * **Why a holder and not a constructor argument.** The boot order makes the obvious thing
 * impossible: `startServer` builds the `/v1/*` app, and only then does `index.ts` build
 * `MobileAdapter` — which is what owns `StructuredSessions`. The adapter reaches the server
 * as an HTTP client (`new ApiClient(host.url, host.apiKey)`), so the dependency runs
 * adapter → server, and nothing can hand the server a session store that does not exist yet.
 *
 * **Why the server needs it at all.** `GET /m/bootstrap` already merges both kinds
 * (`adapters/mobile/http-routes.ts`: `[...fleet.items, ...structured.list()]`), but
 * `POST /v1/list-fleet` reads `ptyManager.list()` alone. That difference is invisible until
 * something outside the phone asks what this host is running — and then a headless cell is
 * simply missing. Measured 2026-09-17: a cell started from Pocket on devbox-vps appeared in
 * the audit log as `cell.spawned tui="false"` and in `/v1/list-fleet` not at all.
 *
 * Unbound it answers with nothing, which is the right answer for a host whose adapter runs
 * no structured sessions — and for every test that does not care.
 */
export interface StructuredSurface {
  /** False until the cells saved by the last run are back; a missing pane then means "not yet", not "gone". */
  ready?(): boolean;
  list(workspaceId?: string): FleetMember[];
  /**
   * A headless cell's conversation, served from memory.
   *
   * There is no transcript file to read for these — the runner speaks a structured protocol
   * and the session holds the turns itself. That is also why a caller cannot fall back to
   * `read-cell-output`: there are no terminal bytes either.
   */
  page(paneId: string): ConversationPage | undefined;
  /** Logged deltas after `cursor` — the resume answer a phone gets. */
  since?(paneId: string, cursor: number): ConversationResume;
  subscribe?(listener: ConversationListener): () => void;
  /** `/v1/chat-cell/:action`, answered with the phone routes' rules. */
  act?(action: string, body: Record<string, unknown>): Promise<ChatActionResult>;
}

export class StructuredFleetRef {
  #surface: StructuredSurface | null = null;
  #closing = false;
  readonly #onClose = new Set<() => void>();

  /** Installed once, by whoever built the adapter. */
  bind(surface: StructuredSurface): void {
    this.#surface = surface;
  }

  /** Whether a missing pane is really gone. False while restoring and once the host is stopping. */
  ready(): boolean {
    return !this.#closing && (this.#surface?.ready?.() ?? true);
  }

  /** The host is stopping: its cells are closed for the restart, not ended, so streams end quietly. */
  close(): void {
    this.#closing = true;
    for (const listener of [...this.#onClose]) listener();
  }

  onClose(listener: () => void): () => void {
    this.#onClose.add(listener);
    return () => this.#onClose.delete(listener);
  }

  list(workspaceId?: string): FleetMember[] {
    return this.#surface?.list(workspaceId) ?? [];
  }

  page(paneId: string): ConversationPage | undefined {
    return this.#surface?.page(paneId);
  }

  since(paneId: string, cursor: number): ConversationResume {
    return this.#surface?.since?.(paneId, cursor) ?? { deltas: [], truncated: false, oldestCursor: 0 };
  }

  subscribe(listener: ConversationListener): () => void {
    return this.#surface?.subscribe?.(listener) ?? (() => {});
  }

  /** Undefined when no adapter runs headless cells. */
  act(action: string, body: Record<string, unknown>): Promise<ChatActionResult> | undefined {
    return this.#surface?.act?.(action, body);
  }
}
