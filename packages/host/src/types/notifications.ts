// ─── Notification events (GET /api/notifications/stream) ─────────────────────

/** An agent process exited — sourced from the hook drop-file mechanism. */
export interface AgentStopEvent {
  kind: "agent_stop";
  pane_id?: string;
  workspace_id?: string;
  agent_type: string;
  /** Hook event behind it (`tool-pre`, `tool-post`, `stop`, …). */
  event: string;
  /** Salient tool argument. Absent for non-tool events. */
  tool_target?: string;
  session_id?: string;
  title: string;
  body: string;
  /** True when `body` was cut by the 8000-byte cap. Absent means it was not. */
  body_truncated?: boolean;
  /**
   * The prompt the agent is working on. Absent on most events.
   *
   * Here so that one forwarded event carries everything one Chat line needs — a
   * client rebuilding the transcript live would otherwise lose the "you asked"
   * bubble until it refetched over HTTP. Cheap because the hook scripts only
   * populate it from `UserPromptSubmit`: it rides once per turn, not once per
   * tool call.
   */
  user_prompt?: string;
  /** Lines added / removed. Absent when the step changed no lines. */
  lines_added?: number;
  lines_removed?: number;
  status: string;
  cwd: string;
  timestamp: number;
}

/** A fleet cell has produced no PTY output for longer than the stall threshold. */
export interface CellStalledEvent {
  kind: "cell_stalled";
  pane_id: string;
  workspace_id: string;
  session_id: string;
  idle_ms: number;
  timestamp: number;
}

/** The broadcast channel dropped events — subscriber should re-sync. */
export interface LaggedEvent {
  kind: "lagged";
  missed: number;
}

/** The Headless Director finished a turn — relayed to the remote chat (ADR-0019). */
export interface DirectorReplyEvent {
  kind: "director_reply";
  text: string;
  session_id: string;
  is_error: boolean;
  timestamp: number;
}

/** Discriminated union of all notification event shapes. */
export type NotificationEvent = AgentStopEvent | CellStalledEvent | LaggedEvent | DirectorReplyEvent;
