// ─── Bridge Tasks ─────────────────────────────────────────────────────────────

export type BridgeTaskStatus =
  | "todo"
  | "in-progress"
  | "in-review"
  | "complete"
  | "cancelled";

export type BridgePriority = "none" | "low" | "medium" | "high";

export interface BridgeTask {
  id: string;
  workspaceId: string;
  teamId?: string;
  title: string;
  goal: string;
  knowledge: string;
  status: BridgeTaskStatus;
  priority: BridgePriority;
  assignees: string[];
  createdAt: number;
  updatedAt: number;
  cellId?: string;
  lastError?: string;
}

export interface CreateTaskRequest {
  workspaceId: string;
  teamId?: string;
  title: string;
  goal: string;
  knowledge?: string;
  assignees?: string[];
  status?: BridgeTaskStatus;
  priority?: BridgePriority;
}

export interface UpdateTaskRequest {
  title?: string;
  goal?: string;
  knowledge?: string;
  status?: BridgeTaskStatus;
  assignees?: string[];
  teamId?: string;
  priority?: BridgePriority;
}

export interface ListTasksQuery {
  workspaceId: string;
  status?: BridgeTaskStatus;
  page?: number;
  pageSize?: number;
}

export interface ListTasksResponse {
  items: BridgeTask[];
  total: number;
  page: number;
  pageSize: number;
}
