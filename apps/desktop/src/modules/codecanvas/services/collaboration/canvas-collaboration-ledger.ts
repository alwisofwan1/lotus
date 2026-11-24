import type { CanvasCollaborationLaunch } from "../canvas-collaboration-launch";

export type CanvasCollaborationAssignmentState = "spawned" | "assigned" | "running" | "done" | "blocked";

export interface CanvasCollaborationAssignmentRecord {
  assignee: string;
  nodeId: string;
  state: CanvasCollaborationAssignmentState;
  spawnedAt: number;
  updatedAt: number;
  lastBrief?: string;
}

export interface CanvasCollaborationLedger {
  runId: string;
  taskId?: string;
  workflowId?: string;
  assignments: Record<string, CanvasCollaborationAssignmentRecord>;
  updatedAt: number;
}

export interface RecordCanvasCollaborationAssigneeSpawnInput {
  assignee: string;
  nodeId: string;
  brief?: string;
  now?: number;
}

export function normalizeCollaborationAssignee(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/^@+/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function recordCanvasCollaborationAssigneeSpawn(
  ledger: CanvasCollaborationLedger,
  input: RecordCanvasCollaborationAssigneeSpawnInput,
): CanvasCollaborationLedger {
  const now = input.now ?? Date.now();
  const key = normalizeCollaborationAssignee(input.assignee);
  if (!key) return { ...ledger };
  return {
    ...ledger,
    assignments: {
      ...ledger.assignments,
      [key]: {
        assignee: input.assignee,
        nodeId: input.nodeId,
        state: "spawned",
        spawnedAt: ledger.assignments[key]?.spawnedAt ?? now,
        updatedAt: now,
        ...(input.brief ? { lastBrief: input.brief } : {}),
      },
    },
    updatedAt: now,
  };
}

export function canvasCollaborationLedgerAssignment(
  ledger: CanvasCollaborationLedger | null | undefined,
  assignee: string,
): CanvasCollaborationAssignmentRecord | undefined {
  const key = normalizeCollaborationAssignee(assignee);
  return key ? ledger?.assignments[key] : undefined;
}

export function canvasCollaborationRunId(launch: CanvasCollaborationLaunch): string | null {
  if (launch.mode === "off") return null;
  const parts: string[] = [launch.mode];
  if (launch.taskId) parts.push(`task:${launch.taskId}`);
  if (launch.workflowId) parts.push(`workflow:${launch.workflowId}`);
  if (launch.workspaceId) parts.push(`workspace:${launch.workspaceId}`);
  return parts.join(":");
}

export function createCanvasCollaborationLedger(runId: string, now = Date.now()): CanvasCollaborationLedger {
  return { runId, assignments: {}, updatedAt: now };
}

export interface CanvasCollaborationLedgerParticipantSnapshot {
  id?: string;
  name: string;
  nodeId?: string;
  source: "task-assignee" | "canvas-agent";
  evidenceCount?: number;
  status: "not-spawned" | "queued" | "starting" | "running" | "done" | "needs-attention";
}

function participantState(status: CanvasCollaborationLedgerParticipantSnapshot["status"]): CanvasCollaborationAssignmentState | null {
  switch (status) {
    case "not-spawned":
      return null;
    case "queued":
      return "assigned";
    case "starting":
    case "running":
      return "running";
    case "done":
      return "done";
    case "needs-attention":
      return "blocked";
  }
}

export function syncCanvasCollaborationLedgerFromParticipants(
  ledger: CanvasCollaborationLedger,
  participants: readonly CanvasCollaborationLedgerParticipantSnapshot[],
  now = Date.now(),
): CanvasCollaborationLedger {
  let changed = false;
  const assignments = { ...ledger.assignments };
  for (const participant of participants) {
    if (participant.source !== "task-assignee" || !participant.nodeId) continue;
    const key = normalizeCollaborationAssignee(participant.name);
    const existing = assignments[key] ?? Object.values(assignments).find((record) => record.nodeId === participant.nodeId);
    const nextState = participantState(participant.status);
    if (!existing || !nextState || existing.state === nextState) continue;
    const existingKey = normalizeCollaborationAssignee(existing.assignee);
    assignments[existingKey] = { ...existing, state: nextState, updatedAt: now };
    changed = true;
  }
  if (!changed) return ledger;
  return { ...ledger, assignments, updatedAt: now };
}
