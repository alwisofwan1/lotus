import type { ChatActionResult, ConversationListener, ConversationPage, ConversationResume } from "../types/conversation.js";
import type { FleetMember } from "../types/fleet.js";

/** Bind structured cells after server startup so fleet IPC can report sessions owned by the later-starting adapter. */
export interface StructuredSurface {
  /** False until the cells saved by the last run are back; a missing pane then means "not yet", not "gone". */
  ready?(): boolean;
  list(workspaceId?: string): FleetMember[];
  /** Use in-memory turns because headless cells have neither a transcript file nor terminal bytes. */
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
