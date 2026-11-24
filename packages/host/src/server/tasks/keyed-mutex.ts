/**
 * Serializes async operations that share a key, while letting different keys
 * run concurrently. Used to make a task's load→mutate→save sequence atomic
 * without blocking unrelated tasks (mirrors the desktop bridge-task Mutex).
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, op: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(op);
    // The stored tail swallows errors so one failed op never blocks the next.
    const tail = result.then(noop, noop);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Number of keys with an in-flight or queued operation. For tests/telemetry. */
  activeKeyCount(): number {
    return this.tails.size;
  }
}

function noop(): void {}
