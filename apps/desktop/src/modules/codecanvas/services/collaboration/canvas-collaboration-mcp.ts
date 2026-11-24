import type { BridgeTask } from "@/lib/tauri-api";
import type { CanvasCollaborationLaunch } from "../canvas-collaboration-launch";
import type { AppendCanvasCollaborationMessageInput, CanvasCollaborationMailboxMessage } from "./canvas-collaboration-mailbox";
import type { CanvasCollaborationParticipantView } from "./canvas-collaboration-participants";

export type CanvasCollaborationMcpAction = "list-participants" | "read-assignment" | "record-evidence" | "mark-blocked";

export interface CanvasCollaborationMcpRequest {
  requestId: string;
  action: CanvasCollaborationMcpAction;
  assignee?: string;
  summary?: string;
  files?: string[];
  checks?: string[];
  blockers?: string[];
}

export interface CanvasCollaborationMcpState {
  launch: CanvasCollaborationLaunch;
  participants: CanvasCollaborationParticipantView[];
  task?: BridgeTask | null;
  mailboxMessages: CanvasCollaborationMailboxMessage[];
}

export type CanvasCollaborationMcpPlan =
  | { ok: true; data: unknown; appendMessage?: AppendCanvasCollaborationMessageInput }
  | { ok: false; error: string };

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function runSummary(launch: CanvasCollaborationLaunch) {
  if (launch.mode === "off") return null;
  return {
    mode: launch.mode,
    sourceLabel: launch.sourceLabel,
    ...(launch.taskId ? { taskId: launch.taskId } : {}),
    ...(launch.workflowId ? { workflowId: launch.workflowId } : {}),
    ...(launch.workspaceId ? { workspaceId: launch.workspaceId } : {}),
  };
}

function taskSummary(task: BridgeTask | null | undefined) {
  if (!task) return null;
  return {
    id: task.id,
    workspaceId: task.workspaceId,
    title: task.title,
    goal: task.goal,
    status: task.status,
    priority: task.priority,
    assignees: task.assignees,
  };
}

function findParticipant(participants: CanvasCollaborationParticipantView[], target: string | undefined): CanvasCollaborationParticipantView | null {
  const raw = target?.trim();
  if (!raw) return null;
  const key = normalize(raw);
  return participants.find((participant) =>
    participant.id === raw ||
    participant.nodeId === raw ||
    normalize(participant.name) === key ||
    normalize(participant.id) === key ||
    (participant.nodeId ? normalize(participant.nodeId) === key : false),
  ) ?? null;
}

function messagesForParticipant(
  messages: CanvasCollaborationMailboxMessage[],
  participant: CanvasCollaborationParticipantView,
): CanvasCollaborationMailboxMessage[] {
  const key = normalize(participant.name);
  return messages
    .filter((message) => (participant.nodeId && message.nodeId === participant.nodeId) || message.assigneeKey === key)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function assignmentSummary(
  participant: CanvasCollaborationParticipantView,
  messages: CanvasCollaborationMailboxMessage[],
) {
  const evidence = messages.filter((message) => message.kind === "evidence");
  const blockers = messages.filter((message) => message.kind === "blocker");
  const latestBlocker = blockers[0] ?? null;
  const latestEvidence = evidence[0] ?? null;
  const nextAction = latestBlocker
    ? "Resolve or clarify the latest blocker, then call lotus_canvas_record_evidence when progress is ready."
    : latestEvidence
      ? "Continue from the latest evidence or wait for review feedback."
      : "Review the handoff brief, complete the assignment, then call lotus_canvas_record_evidence with files and checks.";
  return {
    assignee: participant.name,
    ...(participant.nodeId ? { nodeId: participant.nodeId } : {}),
    status: participant.status,
    source: participant.source,
    evidenceCount: participant.evidenceCount,
    messageCount: messages.length,
    latestEvidence,
    latestBlocker,
    nextAction,
    ...(participant.assignmentState ? { assignmentState: participant.assignmentState } : {}),
    ...(participant.assignmentUpdatedAt ? { assignmentUpdatedAt: participant.assignmentUpdatedAt } : {}),
    ...(participant.assignmentBriefSent !== undefined ? { assignmentBriefSent: participant.assignmentBriefSent } : {}),
  };
}

function stringList(value: string[] | undefined): string[] | undefined {
  const items = (value ?? []).map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function ensureActive(state: CanvasCollaborationMcpState): CanvasCollaborationMcpPlan | null {
  if (state.launch.mode !== "off") return null;
  return { ok: false, error: "No active CodeCanvas collaboration run. Open Canvas from a Swarm Task or Workflow first." };
}

export function planCanvasCollaborationMcpRequest(
  request: CanvasCollaborationMcpRequest,
  state: CanvasCollaborationMcpState,
): CanvasCollaborationMcpPlan {
  const inactive = ensureActive(state);
  if (inactive) return inactive;

  if (request.action === "list-participants") {
    return {
      ok: true,
      data: {
        ok: true,
        run: runSummary(state.launch),
        task: taskSummary(state.task),
        taskFreshness: state.task ? "live-ui" : "unavailable",
        participants: state.participants,
      },
    };
  }

  const participant = findParticipant(state.participants, request.assignee);
  if (!participant) return { ok: false, error: `Collaboration assignee not found: ${request.assignee ?? ""}` };

  if (request.action === "read-assignment") {
    const messages = messagesForParticipant(state.mailboxMessages, participant);
    return {
      ok: true,
      data: {
        ok: true,
        run: runSummary(state.launch),
        task: taskSummary(state.task),
        taskFreshness: state.task ? "live-ui" : "unavailable",
        participant,
        assignment: assignmentSummary(participant, messages),
        messages,
      },
    };
  }

  const summary = request.summary?.trim();
  if (!summary) return { ok: false, error: `Action ${request.action} requires a summary.` };

  if (request.action === "record-evidence") {
    const appendMessage: AppendCanvasCollaborationMessageInput = {
      assignee: participant.name,
      ...(participant.nodeId ? { nodeId: participant.nodeId } : {}),
      kind: "evidence",
      author: "agent",
      body: summary,
      evidence: {
        ...(stringList(request.files) ? { files: stringList(request.files) } : {}),
        ...(stringList(request.checks) ? { checks: stringList(request.checks) } : {}),
      },
    };
    return { ok: true, appendMessage, data: { ok: true, action: request.action, participant, message: appendMessage } };
  }

  if (request.action === "mark-blocked") {
    const appendMessage: AppendCanvasCollaborationMessageInput = {
      assignee: participant.name,
      ...(participant.nodeId ? { nodeId: participant.nodeId } : {}),
      kind: "blocker",
      author: "agent",
      body: summary,
      evidence: {
        ...(stringList(request.blockers) ? { blockers: stringList(request.blockers) } : {}),
      },
    };
    return { ok: true, appendMessage, data: { ok: true, action: request.action, participant, message: appendMessage } };
  }

  return { ok: false, error: `Unsupported canvas collaboration action: ${request.action}` };
}
