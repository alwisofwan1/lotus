import type { ApiClient } from "../../core/api-client.js";
import type { Fields } from "../../core/logger.js";
import type { NotificationEvent } from "../../types/notifications.js";

/** How long to wait before re-attaching. Short: everything here is time-critical. */
export const NOTIFICATIONS_RETRY_MS = 2_000;

export interface NotificationRelayDeps {
  api: ApiClient;
  /** Called for every forwarded event, in order. */
  onEvent: (event: NotificationEvent) => Promise<void> | void;
  warn: (message: string, fields?: Fields) => void;
  /** Injected so a test drives the retry without waiting seconds for it (ADR-13). */
  // `| undefined` because callers forward their own optional `sleep` straight through, and
  // `exactOptionalPropertyTypes` rejects an explicit `undefined` without it.
  sleep?: ((ms: number) => Promise<void>) | undefined;
  retryMs?: number;
}

/**
 * Keeps the desktop's hook-event stream attached, and **re-attaches when it ends**. It feeds
 * live Chat and every FCM wake-up (ADR-4), and a desktop rebuild routinely races this process;
 * one detach silences every paired phone while it looks healthy.
 */
export class NotificationRelay {
  private stopped = false;
  private current: { close: () => void } | null = null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryMs: number;

  constructor(private readonly deps: NotificationRelayDeps) {
    this.sleep =
      deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.retryMs = deps.retryMs ?? NOTIFICATIONS_RETRY_MS;
  }

  /** Begins forwarding. Returns immediately; the loop owns its own lifetime. */
  start(): void {
    this.stopped = false;
    void this.run();
  }

  /**
   * Ends the loop and closes the open stream. The flag is set before closing, or the loop
   * reads its own close as an interruption and reconnects.
   */
  stop(): void {
    this.stopped = true;
    this.current?.close();
    this.current = null;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        const stream = this.deps.api.streamNotifications();
        this.current = stream;
        for await (const event of stream.events()) {
          await this.deps.onEvent(event);
        }
        // A clean end is still an end: the desktop went away without erroring, and the
        // old code treated only the throwing case as worth mentioning.
        this.deps.warn("mobile.notifications.stream_ended", { reason: "closed" });
      } catch (error) {
        this.deps.warn("mobile.notifications.stream_ended", { error: String(error) });
      }
      this.current = null;
      if (this.stopped) return;
      await this.sleep(this.retryMs);
    }
  }
}
