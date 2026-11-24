/**
 * SwarmTask — the standalone host's durable task model. Field names and enum
 * values mirror the desktop `BridgeTask` (src-tauri/src/bridge_tasks.rs) exactly
 * so the `/v1/tasks/*` MCP-IPC Contract stays provider- and host-neutral
 * (ADR-0019). Keep this in sync with that source; a contract test guards it.
 */

export type TaskStatus = "todo" | "in-progress" | "blocked" | "in-review" | "complete" | "cancelled";
export type TaskPriority = "none" | "low" | "medium" | "high";
export type SubTaskStatus = "pending" | "in-progress" | "completed";

export type IntakeDecision = "assign" | "ask-human" | "blocked";
export type BlockerPhase = "intake" | "assignment" | "execution" | "review";
export type BlockerType =
  | "human-input" | "ambiguity" | "auth" | "dependency" | "verification-failed" | "system-error";
export type FeedbackActor = "director" | "human" | "agent" | "reviewer" | "system";
export type FeedbackKind =
  | "intake-created" | "hitl-question" | "hitl-answer" | "assignment-plan-created"
  | "assignment-dispatched" | "agent-result" | "review-requested" | "review-verdict"
  | "revision-requested" | "task-blocked" | "task-status-changed";

export interface SubTask {
  id: string;
  title: string;
  status: SubTaskStatus;
  assignedTo?: string;
}

export interface TaskIntake {
  briefXml: string;
  confidence: number;
  decision: IntakeDecision;
  updatedAt: number;
}

export interface TaskBlocker {
  phase: BlockerPhase;
  /** Mirrors the serde `#[serde(rename = "type")]` on the Rust `kind` field. */
  type: BlockerType;
  reason: string;
  questionId?: string;
}

export interface TaskFeedbackEvent {
  id: string;
  at: number;
  actor: FeedbackActor;
  kind: FeedbackKind;
  summary: string;
  payload?: unknown;
}

export interface SwarmTask {
  id: string;
  workspaceId: string;
  teamId?: string;
  title: string;
  goal: string;
  knowledge: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignees: string[];
  createdAt: number;
  updatedAt: number;
  cellId?: string;
  lastError?: string;
  subtasks: SubTask[];
  dueDate?: number;
  intake?: TaskIntake;
  blocker?: TaskBlocker;
  feedbackEvents: TaskFeedbackEvent[];
}

export interface CreateTaskInput {
  workspaceId: string;
  teamId?: string;
  title: string;
  goal: string;
  knowledge?: string;
  assignees?: string[];
  status?: TaskStatus;
  priority?: TaskPriority;
  subtasks?: SubTask[];
  dueDate?: number;
}

/**
 * Patch semantics: an absent field is left untouched; for the nullable fields
 * (`cellId`, `lastError`, `dueDate`, `blocker`) an explicit `null` clears it.
 * This mirrors the Rust tri-state `Option<Option<T>>` patch fields.
 */
export interface UpdateTaskPatch {
  title?: string;
  goal?: string;
  knowledge?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  teamId?: string;
  assignees?: string[];
  subtasks?: SubTask[];
  intake?: TaskIntake;
  feedbackEvents?: TaskFeedbackEvent[];
  cellId?: string | null;
  lastError?: string | null;
  dueDate?: number | null;
  blocker?: TaskBlocker | null;
}

export interface TaskListFilter {
  workspaceId?: string;
  status?: TaskStatus;
  /** Keeps only tasks whose `assignees` include this label. */
  assignee?: string;
}
