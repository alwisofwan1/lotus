import { STREAM_TTL_MS } from "./constants.js";

export interface Stoppable {
  stop(): void;
}

interface Entry<T extends Stoppable> {
  streamer: T;
  lastActivity: number;
}

/** Expire inactive streams so abandoned subscriptions stop consuming resources. */
export class StreamRegistry<T extends Stoppable = Stoppable> {
  private readonly entries = new Map<string, Entry<T>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ttlMs: number = STREAM_TTL_MS,
    private readonly sweepIntervalMs: number = 5 * 60 * 1000,
  ) {}

  set(deviceId: string, streamer: T): void {
    this.entries.get(deviceId)?.streamer.stop();
    this.entries.set(deviceId, { streamer, lastActivity: Date.now() });
    this.ensureSweeping();
  }

  get(deviceId: string): T | undefined {
    return this.entries.get(deviceId)?.streamer;
  }

  /** Reset the inactivity clock for a chat — call on each data event. */
  touch(deviceId: string): void {
    const entry = this.entries.get(deviceId);
    if (entry) entry.lastActivity = Date.now();
  }

  delete(deviceId: string): void {
    this.entries.get(deviceId)?.streamer.stop();
    this.entries.delete(deviceId);
    if (this.entries.size === 0) this.stopSweeping();
  }

  /** Stop all active streams and clear the registry. */
  clear(): void {
    for (const { streamer } of this.entries.values()) streamer.stop();
    this.entries.clear();
    this.stopSweeping();
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private ensureSweeping(): void {
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    }
  }

  private stopSweeping(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [deviceId, entry] of this.entries) {
      if (now - entry.lastActivity > this.ttlMs) {
        entry.streamer.stop();
        this.entries.delete(deviceId);
      }
    }
    if (this.entries.size === 0) this.stopSweeping();
  }
}
