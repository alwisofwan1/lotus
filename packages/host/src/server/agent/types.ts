/**
 * AgentProviderId — identifies which agent runtime handles a request.
 *
 * - "claude"        → claude CLI (claude --print --output-format stream-json)
 * - "codex"         → codex CLI (codex --quiet)
 * - "ccs:<account>" → ccs account (ccs initech -p "..." / ccs initech:continue)
 *
 * CCS accounts are auto-discovered from ~/.ccs/config.yaml at startup.
 */
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
  /**
   * The posture the operator chose, in the vocabulary the host advertises
   * (`permissionModeIds()` — claude's own `--permission-mode` values, plus `safe`/`yolo`).
   *
   * Absent means the runner's own default. It exists because the phone has been offered
   * this scale since `spawn-tuning`, and until 2026-09-05 there was no field to carry the
   * answer: `claude.ts` wrote `--dangerously-skip-permissions` whatever was picked.
   * ADR-8 makes that unfixable once the cell is running, so it has to be right at spawn.
   */
  permissionMode?: string;
  /**
   * `spawn-tuning`: a model alias and an effort level, in the runner's **own** vocabulary and
   * exactly as `bootstrap.runners[]` advertised them. Absent keeps the CLI's own default.
   *
   * **Forwarded, never translated.** `cell-routes.ts` takes both as free text on purpose —
   * *"the CLI is the only thing that can finally judge an alias"* — so nothing between the
   * phone and the process re-checks them against a list. A stale catalog then narrows what
   * the phone **offers** without blocking what it can send.
   *
   * Absent rather than `undefined` at the call site, for a reason a command line makes
   * concrete: a runner that spreads its request would write `--model undefined`.
   */
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
