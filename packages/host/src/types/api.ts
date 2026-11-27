// ─── Lotus HTTP API types (mirrors Rust models.rs) ────────────────────────────

export interface SessionInfo {
  id: string;
  cwd: string;
}

export interface CreatedSession {
  sessionId: string;
}

export interface CreateSessionRequest {
  cwd?: string;
  cols?: number;
  rows?: number;
  command?: string[];
  provider?: BridgeProvider;
  /**
   * The runner's own name, when it differs from its family — the account behind
   * `ccs:initech`. `provider` is the family a client routes on; this is what an operator
   * reads (`types/fleet.ts` keeps the two apart and says why).
   */
  runnerLabel?: string;
  workspaceId?: string;
  title?: string;
  /** Carried so the session can report its own posture later — see `PtySessionState`. */
  permissionMode?: string;
}

export interface InputRequest {
  data: string;
}

export interface AgentConfig {
  name: string;
  role: string;
  model: string;
  prompt: string;
}

export interface LaunchConfig {
  name: string;
  project?: string;
  projectDir?: string;
  goal?: string;
  displayMode?: string;
  requirePlanApproval?: boolean;
  leadModel?: string;
  agents: AgentConfig[];
  tasks?: string[];
  dryRun?: boolean;
}

export interface LaunchResult {
  ok: boolean;
  teamId: string;
  pid?: number;
  logFile: string;
  workDir: string;
  shellCmd: string;
}

export interface LaunchPtyResult {
  ok: boolean;
  teamId: string;
  sessionId: string;
  workDir: string;
  shellCmd: string;
}

/** Keep the provider union closed so new bridges force consumers to handle their type. */
export type BridgeProvider = "claude" | "codex" | "cursor" | "qwen";

export type BridgeIntent = "read" | "plan" | "write";

export interface BridgeChatRequest {
  text: string;
  sessionId?: string | null;
  model?: string;
  cwd?: string;
  provider?: BridgeProvider;
  intent?: BridgeIntent;
  approved?: boolean;
  /** API key for the provider (qwen/openai-compat). Never logged. */
  apiKey?: string;
  /** Base URL for the provider API endpoint. */
  baseUrl?: string;
  /** Remote Session Scope — expose Remote-Scoped Skills to this run (ADR-0018). */
  remoteScoped?: boolean;
}

export interface BridgeChatResponse {
  sessionId: string;
  text: string;
  isError: boolean;
  provider: BridgeProvider;
}

export interface ProcessInfo {
  pid: number;
  teamId?: string;
  projectDir?: string;
  startedAt: string;
  cmd: string;
}

export interface HealthResponse {
  ok: boolean;
  port: number;
  version: string;
}
