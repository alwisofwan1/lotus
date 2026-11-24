// Adapted from bb (plugins/provider-claude-code/src/bridge/sdk-session.ts),
// Copyright (c) 2026 Michael Yong, MIT License — see ./LICENSE-bb.
//
// An async iterable the Agent SDK reads user messages from. Each push returns a promise that
// settles when the SDK actually takes the message, so a turn can be opened at that moment
// (bb commit 53fdb6159) instead of waiting for the first model output.

export class InputQueue<T> implements AsyncIterable<T> {
  private readonly pending: Array<{ value: T; consumed: () => void; rejected: (error: Error) => void }> = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  push(value: T): Promise<void> {
    if (this.closed) return Promise.reject(new Error("input queue is closed"));
    return new Promise<void>((resolve, reject) => {
      if (this.waiting) {
        const deliver = this.waiting;
        this.waiting = null;
        deliver({ value, done: false });
        resolve();
        return;
      }
      this.pending.push({ value, consumed: resolve, rejected: reject });
    });
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error(reason);
    for (const entry of this.pending.splice(0)) entry.rejected(error);
    if (this.waiting) {
      const deliver = this.waiting;
      this.waiting = null;
      deliver({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const entry = this.pending.shift();
        if (entry) {
          entry.consumed();
          return Promise.resolve({ value: entry.value, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiting = resolve;
        });
      },
      return: () => {
        this.close("input iterator returned");
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
