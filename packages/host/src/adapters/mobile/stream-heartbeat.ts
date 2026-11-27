/**
 * Keeps `/m/stream` sockets honest (`issues/10`): with no ping nobody can tell a dead socket
 * from a quiet one, and the phone's reconnect never fires. A protocol-level ping fixes both
 * directions and every WebSocket client answers it.
 */

/** How often to ping. Under every NAT idle window worth worrying about, and cheap. */
export const HEARTBEAT_MS = 30_000;

/** The little a socket must offer to be kept honest. */
export interface Heartbeatable {
  ping(): void;
  terminate(): void;
}

export class StreamHeartbeat {
  /** Sockets that have been pinged and not yet answered. */
  private readonly awaiting = new Set<Heartbeatable>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly clients: () => Iterable<Heartbeatable>,
    private readonly intervalMs: number = HEARTBEAT_MS,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    // Never hold the process open for a heartbeat: this is a background chore, not work.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.awaiting.clear();
  }

  /** A socket answered. Called from the transport's `pong`. */
  pong(socket: Heartbeatable): void {
    this.awaiting.delete(socket);
  }

  tick(): void {
    for (const socket of this.clients()) {
      if (this.awaiting.has(socket)) {
        // A whole interval with no answer. Terminating rather than closing politely: a socket
        // that cannot answer a ping will not complete a closing handshake either.
        this.awaiting.delete(socket);
        socket.terminate();
        continue;
      }
      this.awaiting.add(socket);
      socket.ping();
    }
  }

  size(): number {
    return this.awaiting.size;
  }
}
