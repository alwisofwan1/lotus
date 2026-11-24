// ─── Discovery file (~/.claude/api-server.json) ───────────────────────────────

export interface ApiServerDiscovery {
  port: number;
  keyFile: string;
  version: string;
}

// ─── Adapter interface ────────────────────────────────────────────────────────

/** Every transport adapter implements this interface. */
export interface RemoteAdapter {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}
