export type AgentProviderId = "claude" | "codex" | `ccs:${string}`;

export interface AgentChatRequest {
  prompt: string;
  /** Resume a prior conversation. Provider-specific meaning. */
  sessionId?: string | null;
  /** Absolute path of the HostedProject to work in. */
  cwd: string;
  provider: AgentProviderId;
  /** Remote Session Scope — expose Remote-Scoped Skills to this run (ADR-0018). */
  remoteScoped?: boolean;
  /** Model alias passed to the provider CLI (e.g. "sonnet"). Omit for the default. */
  model?: string;
  /** Aborts the underlying CLI process (turn timeout / client disconnect). */
  signal?: AbortSignal;
}

export interface AgentChatResponse {
  sessionId: string;
  text: string;
  isError: boolean;
  provider: AgentProviderId;
}

export interface AgentSpawnRequest {
  /** Absolute path of the HostedProject to work in. */
  cwd: string;
  provider: AgentProviderId;
  /** Initial prompt injected after spawn (optional). */
  prompt?: string;
  /** Remote Session Scope — expose Remote-Scoped Skills to this run (ADR-0018). */
  remoteScoped?: boolean;
  /** Set the selected permission mode at launch because it cannot be corrected afterward (ADR-8). */
  permissionMode?: string;
  /** Forward tuning values so only the runner decides which aliases it supports. */
  model?: string;
  effort?: string;
  /** Claude only: `CLAUDE_CONFIG_DIR` for this cell; null unsets it (`default`), absent leaves the env alone. */
  configDir?: string | null;
}

/**
 * AgentRunner — contract that every provider implementation must satisfy.
 */
export interface AgentRunner {
  readonly providerId: AgentProviderId;
  /**
   * Single-turn or resumed chat via the provider's --print mode.
   * Returns the full response text and a session ID for --resume.
   */
  chat(req: AgentChatRequest): Promise<AgentChatResponse>;
  /**
   * Spawn the provider inside a PTY session for interactive use.
   * Returns the PTY session ID so the caller can stream output.
   */
  spawnPty(req: AgentSpawnRequest, ptySessionId: string): Promise<void>;
}
