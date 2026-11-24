import type { BridgeTask, BridgeTaskFeedbackEvent } from "@/lib/tauri-api";
import type { AgentDefinition, AgentNodeStatus } from "../../types/canvas";
import type { CanvasCollaborationMailboxMessage } from "./canvas-collaboration-mailbox";
import {
  canvasCollaborationLedgerAssignment,
  normalizeCollaborationAssignee,
  type CanvasCollaborationAssignmentRecord,
  type CanvasCollaborationAssignmentState,
  type CanvasCollaborationLedger,
} from "./canvas-collaboration-ledger";

export type CanvasCollaborationParticipantStatus =
  | "not-spawned"
  | "queued"
  | "starting"
  | "running"
  | "done"
  | "needs-attention";

export type CanvasCollaborationParticipantSource = "task-assignee" | "canvas-agent";

export interface CanvasCollaborationAgentSnapshot {
  id: string;
  name: string;
  status: AgentNodeStatus;
  role?: string;
}

export interface CanvasCollaborationParticipantView {
  id: string;
  /** Canvas AgentNode id when this participant is backed by an actual node. */
  nodeId?: string;
  name: string;
  role?: string;
  status: CanvasCollaborationParticipantStatus;
  source: CanvasCollaborationParticipantSource;
  evidenceCount: number;
  lastEventSummary?: string;
  assignmentState?: CanvasCollaborationAssignmentState;
  assignmentUpdatedAt?: number;
  assignmentBriefSent?: boolean;
}

export interface ProjectCanvasCollaborationParticipantsInput {
  task?: BridgeTask | null;
  agents: CanvasCollaborationAgentSnapshot[];
  ledger?: CanvasCollaborationLedger | null;
  mailboxMessages?: CanvasCollaborationMailboxMessage[];
}

function normalize(value: string): string {
  return normalizeCollaborationAssignee(value);
}

/**
 * Deliberately exhaustive, with no `default`.
 *
 * That is not an oversight — it is the guard that works. Widening `AgentNodeStatus` with
 * `needs-you` made this function fall off the end and return `undefined`, and the production
 * `next build` type check refused it (`TS2366`). A `default` would have turned that loud failure
 * into a silent mapping, which for a status vocabulary is the worse trade: the next member added
 * upstream deserves a decision here, not a fallback.
 */
function agentStatus(status: AgentNodeStatus): CanvasCollaborationParticipantStatus {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    // A human is required before this agent can continue. The collaboration vocabulary already had
    // the right word for it, so this needed no new participant state.
    case "needs-you":
      return "needs-attention";
    case "completed":
      return "done";
    case "error":
      return "needs-attention";
    case "stalled":
      return "needs-attention";
    case "idle":
      return "queued";
  }
}

function objectValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function payloadTarget(event: BridgeTaskFeedbackEvent): string | null {
  const payload = event.payload;
  const direct = objectValue(payload, "member") ?? objectValue(payload, "assignee") ?? objectValue(payload, "agent") ?? objectValue(payload, "target");
  return typeof direct === "string" && direct.trim() ? direct : null;
}

function eventMatches(event: BridgeTaskFeedbackEvent, name: string): boolean {
  const target = payloadTarget(event);
  if (target) return normalize(target) === normalize(name);
  return normalize(event.summary).includes(normalize(name));
}

function isFailureEvent(event: BridgeTaskFeedbackEvent): boolean {
  if (event.kind === "task-blocked" || event.kind === "revision-requested") return true;
  if (event.kind !== "review-verdict") return false;
  const verdict = objectValue(event.payload, "verdict");
  return (typeof verdict === "string" && verdict.toLocaleUpperCase() === "FAIL") || /\bFAIL\b/i.test(event.summary);
}

function relevantEvents(task: BridgeTask | null | undefined, name: string): BridgeTaskFeedbackEvent[] {
  return [...(task?.feedbackEvents ?? [])]
    .filter((event) => eventMatches(event, name))
    .sort((a, b) => b.at - a.at);
}

function evidenceCount(events: BridgeTaskFeedbackEvent[], messages: CanvasCollaborationMailboxMessage[] = []): number {
  return events.filter((event) => event.kind === "agent-result").length + messages.filter((message) => message.kind === "evidence").length;
}

type AssignmentAction =
  | { kind: "evidence"; summary: string; at: number }
  | { kind: "blocker"; summary: string; at: number };

function latestAssignmentAction(events: BridgeTaskFeedbackEvent[], messages: CanvasCollaborationMailboxMessage[]): AssignmentAction | null {
  const actions: AssignmentAction[] = [
    ...events
      .filter((event) => event.kind === "agent-result" || isFailureEvent(event))
      .map((event) => ({ kind: isFailureEvent(event) ? "blocker" as const : "evidence" as const, summary: event.summary, at: event.at })),
    ...messages
      .filter((message) => message.kind === "evidence" || message.kind === "blocker")
      .map((message) => ({ kind: message.kind === "blocker" ? "blocker" as const : "evidence" as const, summary: message.body, at: message.createdAt })),
  ];
  return actions.sort((a, b) => b.at - a.at)[0] ?? null;
}

function mailboxMessagesForAssignee(
  messages: CanvasCollaborationMailboxMessage[] | undefined,
  name: string,
  agent: CanvasCollaborationAgentSnapshot | undefined,
): CanvasCollaborationMailboxMessage[] {
  const assigneeKey = normalize(name);
  return [...(messages ?? [])]
    .filter((message) => (agent?.id && message.nodeId === agent.id) || message.assigneeKey === assigneeKey)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function statusForAssignee(
  agent: CanvasCollaborationAgentSnapshot | undefined,
  events: BridgeTaskFeedbackEvent[],
  messages: CanvasCollaborationMailboxMessage[],
): CanvasCollaborationParticipantStatus {
  const latestActionable = latestAssignmentAction(events, messages);
  if (latestActionable) return latestActionable.kind === "blocker" ? "needs-attention" : "done";
  if (!agent) return "not-spawned";
  return agentStatus(agent.status);
}

function viewForAssignee(
  name: string,
  agent: CanvasCollaborationAgentSnapshot | undefined,
  task: BridgeTask | null | undefined,
  assignment?: CanvasCollaborationAssignmentRecord,
  mailboxMessages?: CanvasCollaborationMailboxMessage[],
): CanvasCollaborationParticipantView {
  const events = relevantEvents(task, name);
  const messages = mailboxMessagesForAssignee(mailboxMessages, name, agent);
  const latestAction = latestAssignmentAction(events, messages);
  return {
    id: agent?.id ?? `assignee:${normalize(name)}`,
    ...(agent?.id ? { nodeId: agent.id } : {}),
    name: agent?.name ?? name,
    ...(agent?.role ? { role: agent.role } : {}),
    status: statusForAssignee(agent, events, messages),
    source: "task-assignee",
    evidenceCount: evidenceCount(events, messages),
    ...(latestAction?.summary ? { lastEventSummary: latestAction.summary } : events[0]?.summary ? { lastEventSummary: events[0].summary } : {}),
    ...(assignment ? {
      assignmentState: assignment.state,
      assignmentUpdatedAt: assignment.updatedAt,
      assignmentBriefSent: Boolean(assignment.lastBrief),
    } : {}),
  };
}

function viewForCanvasAgent(agent: CanvasCollaborationAgentSnapshot): CanvasCollaborationParticipantView {
  return {
    id: agent.id,
    nodeId: agent.id,
    name: agent.name,
    ...(agent.role ? { role: agent.role } : {}),
    status: agentStatus(agent.status),
    source: "canvas-agent",
    evidenceCount: 0,
  };
}

/**
 * Projects Swarm task assignees plus live Canvas AgentNodes into the collaboration
 * participant list shown by the opt-in Canvas ledger overlay.
 */
export function projectCanvasCollaborationParticipants(
  input: ProjectCanvasCollaborationParticipantsInput,
): CanvasCollaborationParticipantView[] {
  const byName = new Map(input.agents.map((agent) => [normalize(agent.name), agent]));
  const byId = new Map(input.agents.map((agent) => [agent.id, agent]));
  const usedAgentIds = new Set<string>();
  const views: CanvasCollaborationParticipantView[] = [];

  for (const assignee of input.task?.assignees ?? []) {
    const name = assignee.trim();
    if (!name) continue;
    const assignment = canvasCollaborationLedgerAssignment(input.ledger, name);
    const agent = assignment ? byId.get(assignment.nodeId) ?? byName.get(normalize(name)) : byName.get(normalize(name));
    if (agent) usedAgentIds.add(agent.id);
    views.push(viewForAssignee(name, agent, input.task, assignment, input.mailboxMessages));
  }

  for (const agent of input.agents) {
    if (!usedAgentIds.has(agent.id)) views.push(viewForCanvasAgent(agent));
  }

  return views;
}

export function missingAssigneeParticipants(
  participants: readonly CanvasCollaborationParticipantView[],
): CanvasCollaborationParticipantView[] {
  return participants.filter((participant) =>
    participant.source === "task-assignee" && participant.status === "not-spawned",
  );
}

export interface BuildMissingAssigneeAgentDefinitionsOptions {
  taskTitle?: string;
  task?: BridgeTask | null;
  projectId?: string | null;
  runId?: string | null;
  now?: number;
}

export interface CanvasCollaborationAssigneeSpawnSpec {
  participant: CanvasCollaborationParticipantView;
  definition: AgentDefinition;
  brief: string;
}

function promptForMissingAssignee(name: string, taskTitle?: string): string {
  const scope = taskTitle?.trim() ? ` for the Swarm task \"${taskTitle.trim()}\"` : " for the active Swarm task";
  return [
    `You are ${name}, a Canvas AgentNode spawned from a Swarm task assignee${scope}.`,
    "Stay headless unless the user promotes you to a terminal. Use the initial task brief as your assignment handoff.",
    "When you finish, report concise evidence: changed files, checks run, result summary, and any blockers.",
  ].join("\n");
}

function taskTitle(options: BuildMissingAssigneeAgentDefinitionsOptions): string | undefined {
  return options.task?.title ?? options.taskTitle;
}

function nonEmptyLine(label: string, value: string | undefined): string[] {
  const trimmed = value?.trim();
  return trimmed ? [`${label}: ${trimmed}`] : [];
}

function assigneeSubtaskLines(task: BridgeTask, assignee: string): string[] {
  const target = normalize(assignee);
  return (task.subtasks ?? [])
    .filter((subtask) => !subtask.assignedTo || normalize(subtask.assignedTo) === target)
    .map((subtask) => `- [${subtask.status}] ${subtask.title}`);
}

function recentEventLines(task: BridgeTask, assignee: string): string[] {
  return relevantEvents(task, assignee)
    .slice(0, 3)
    .map((event) => `- ${event.actor}: ${event.summary}`);
}

function buildAssigneeBrief(participant: CanvasCollaborationParticipantView, options: BuildMissingAssigneeAgentDefinitionsOptions): string {
  const task = options.task;
  const lines = [
    "Swarm task assignment handoff",
    `Assignee: ${participant.name}`,
    ...nonEmptyLine("Role", participant.role),
    ...nonEmptyLine("projectId", options.projectId ?? undefined),
    ...nonEmptyLine("runId", options.runId ?? undefined),
  ];

  if (task) {
    const subtasks = assigneeSubtaskLines(task, participant.name);
    const events = recentEventLines(task, participant.name);
    lines.push(
      `Task: ${task.title}`,
      `Status: ${task.status}`,
      `Priority: ${task.priority}`,
      ...nonEmptyLine("Goal", task.goal),
      ...nonEmptyLine("Knowledge", task.knowledge),
    );
    if (subtasks.length) lines.push("Relevant subtasks:", ...subtasks);
    if (events.length) lines.push("Recent assignment events:", ...events);
  } else {
    lines.push("Task: Active Swarm collaboration task");
  }

  lines.push(
    "MCP tools: call lotus_canvas_read_assignment for your current mailbox thread, lotus_canvas_record_evidence when you have proof, and lotus_canvas_mark_blocked when you need input or verification is failing.",
    "Report evidence when complete: changed files, checks run, summary, and blockers.",
    "If requirements are ambiguous or blocked, stop and ask for clarification instead of guessing.",
  );
  return lines.join("\n");
}

function buildDefinition(
  participant: CanvasCollaborationParticipantView,
  options: BuildMissingAssigneeAgentDefinitionsOptions,
): AgentDefinition {
  return {
    id: `collab-assignee-${normalize(participant.name)}`,
    name: participant.name,
    role: participant.role ?? "Swarm task assignee",
    model: "",
    prompt: promptForMissingAssignee(participant.name, taskTitle(options)),
    appliedSkills: [],
    effort: "medium",
    permissionMode: "full",
    runner: "claude",
    updatedAt: options.now ?? Date.now(),
  };
}

export function buildMissingAssigneeSpawnSpecs(
  participants: readonly CanvasCollaborationParticipantView[],
  options: BuildMissingAssigneeAgentDefinitionsOptions = {},
): CanvasCollaborationAssigneeSpawnSpec[] {
  return missingAssigneeParticipants(participants).map((participant) => ({
    participant,
    definition: buildDefinition(participant, options),
    brief: buildAssigneeBrief(participant, options),
  }));
}

export function buildMissingAssigneeAgentDefinitions(
  participants: readonly CanvasCollaborationParticipantView[],
  options: BuildMissingAssigneeAgentDefinitionsOptions = {},
): AgentDefinition[] {
  return buildMissingAssigneeSpawnSpecs(participants, options).map((spec) => spec.definition);
}
