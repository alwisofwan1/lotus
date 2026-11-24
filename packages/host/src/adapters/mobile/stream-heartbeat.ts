/**
 * Keeps `/m/stream` sockets honest, and it is `issues/10` reopened.
 *
 * That issue was written about Cloudflare's idle timeout and deprioritised when Tailscale took
 * Cloudflare out of the path. That closed one of its two halves. The other half is worse and has
 * nothing to do with any proxy: **with no ping in either direction, nobody can tell a dead socket
 * from a quiet one.** The host keeps writing frames into a connection that no longer reaches
 * anyone, and the phone keeps believing it is subscribed, so its reconnect never fires.
 *
 * Measured on devbox-vps 2026-09-06, with an operator watching a Chat page that would not move:
 * the phone held **three** established sockets at once, and their ports changed between two
 * readings — it had been reconnecting all along while every previous socket stayed open here,
 * receiving frames nothing would ever read. A TCP ACK is not proof an app read anything; the
 * kernel acknowledges into a buffer whether or not anyone drains it.
 *
 * A protocol-level ping fixes both directions at once, and needs nothing from the client: every
 * WebSocket implementation answers a ping automatically, so an old phone build benefits without
 * being rebuilt.
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
