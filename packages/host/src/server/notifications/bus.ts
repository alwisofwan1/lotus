import type { NotificationEvent } from "../../types/index.js";

type Subscriber = (event: NotificationEvent) => void;

/** Synchronous pub/sub channel for notification events. Thread-safe for Node.js. */
export class NotificationBus {
  private readonly subscribers = new Set<Subscriber>();

  subscribe(handler: Subscriber): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  publish(event: NotificationEvent): void {
    for (const handler of this.subscribers) {
      handler(event);
    }
  }

  stop(): void {
    this.subscribers.clear();
  }

  get size(): number {
    return this.subscribers.size;
  }
}
