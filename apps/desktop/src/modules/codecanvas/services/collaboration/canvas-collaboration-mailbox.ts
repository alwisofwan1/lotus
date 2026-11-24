import type { BridgeTask, BridgeTaskFeedbackEvent } from "@/lib/tauri-api";
import { normalizeCollaborationAssignee } from "./canvas-collaboration-ledger";

export type CanvasCollaborationMailboxMessageKind = "handoff" | "reply" | "evidence" | "blocker" | "note";
export type CanvasCollaborationMailboxAuthor = "human" | "agent" | "director" | "reviewer" | "system";

export interface CanvasCollaborationEvidencePayload {
  files?: string[];
  checks?: string[];
  blockers?: string[];
}

export interface CanvasCollaborationMailboxMessage {
  id: string;
  assignee: string;
  assigneeKey: string;
  nodeId?: string;
  kind: CanvasCollaborationMailboxMessageKind;
  author: CanvasCollaborationMailboxAuthor;
  body: string;
  createdAt: number;
  evidence?: CanvasCollaborationEvidencePayload;
}

export interface CanvasCollaborationMailbox {
  runId: string;
  messages: CanvasCollaborationMailboxMessage[];
  updatedAt: number;
}

export interface AppendCanvasCollaborationMessageInput {
  id?: string;
  assignee: string;
  nodeId?: string;
  kind: CanvasCollaborationMailboxMessageKind;
  author: CanvasCollaborationMailboxAuthor;
  body: string;
  now?: number;
  evidence?: CanvasCollaborationEvidencePayload;
}

export interface ListCanvasCollaborationMessagesFilter {
  assignee?: string;
  nodeId?: string;
  kind?: CanvasCollaborationMailboxMessageKind;
}

export interface RecordCanvasCollaborationEvidenceInput {
  id?: string;
  assignee: string;
  nodeId?: string;
  summary: string;
  files?: string[];
  checks?: string[];
  blockers?: string[];
  now?: number;
}

function messageId(now: number): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `mail-${now}-${random}`;
}

export function createCanvasCollaborationMailbox(runId: string, now = Date.now()): CanvasCollaborationMailbox {
  return { runId, messages: [], updatedAt: now };
}

export function appendCanvasCollaborationMessage(
  mailbox: CanvasCollaborationMailbox,
  input: AppendCanvasCollaborationMessageInput,
): CanvasCollaborationMailbox {
  const body = input.body.trim();
  const assignee = input.assignee.trim();
  const assigneeKey = normalizeCollaborationAssignee(assignee);
  if (!body || !assigneeKey) return mailbox;
  if (input.id && mailbox.messages.some((message) => message.id === input.id)) return mailbox;
  const now = input.now ?? Date.now();
  const message: CanvasCollaborationMailboxMessage = {
    id: input.id ?? messageId(now),
    assignee,
    assigneeKey,
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    kind: input.kind,
    author: input.author,
    body,
    createdAt: now,
    ...(input.evidence ? { evidence: input.evidence } : {}),
  };
  return {
    ...mailbox,
    messages: [...mailbox.messages, message].sort((a, b) => a.createdAt - b.createdAt),
    updatedAt: now,
  };
}

export function recordCanvasCollaborationEvidence(
  mailbox: CanvasCollaborationMailbox,
  input: RecordCanvasCollaborationEvidenceInput,
): CanvasCollaborationMailbox {
  return appendCanvasCollaborationMessage(mailbox, {
    id: input.id,
    assignee: input.assignee,
    nodeId: input.nodeId,
    kind: "evidence",
    author: "agent",
    body: input.summary,
    now: input.now,
    evidence: {
      ...(input.files ? { files: input.files } : {}),
      ...(input.checks ? { checks: input.checks } : {}),
      ...(input.blockers ? { blockers: input.blockers } : {}),
    },
  });
}

export function listCanvasCollaborationMessages(
  mailbox: CanvasCollaborationMailbox | null | undefined,
  filter: ListCanvasCollaborationMessagesFilter = {},
): CanvasCollaborationMailboxMessage[] {
  const assigneeKey = filter.assignee ? normalizeCollaborationAssignee(filter.assignee) : null;
  return [...(mailbox?.messages ?? [])]
    .filter((message) => !assigneeKey || message.assigneeKey === assigneeKey)
    .filter((message) => !filter.nodeId || message.nodeId === filter.nodeId)
    .filter((message) => !filter.kind || message.kind === filter.kind)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function objectValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

function feedbackAssignee(event: BridgeTaskFeedbackEvent): string | null {
  const payload = event.payload;
  const direct = objectValue(payload, "member") ?? objectValue(payload, "assignee") ?? objectValue(payload, "agent") ?? objectValue(payload, "target");
  return typeof direct === "string" && direct.trim() ? direct.trim() : null;
}

function feedbackEvidence(payload: unknown): CanvasCollaborationEvidencePayload | undefined {
  const evidence = {
    ...(stringArrayValue(objectValue(payload, "files")) ? { files: stringArrayValue(objectValue(payload, "files")) } : {}),
    ...(stringArrayValue(objectValue(payload, "checks")) ? { checks: stringArrayValue(objectValue(payload, "checks")) } : {}),
    ...(stringArrayValue(objectValue(payload, "blockers")) ? { blockers: stringArrayValue(objectValue(payload, "blockers")) } : {}),
  };
  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

function isFailVerdict(event: BridgeTaskFeedbackEvent): boolean {
  if (event.kind !== "review-verdict") return false;
  const verdict = objectValue(event.payload, "verdict");
  return (typeof verdict === "string" && verdict.toLocaleUpperCase() === "FAIL") || /\bFAIL\b/i.test(event.summary);
}

function messageKindForFeedback(event: BridgeTaskFeedbackEvent): CanvasCollaborationMailboxMessageKind | null {
  if (event.kind === "agent-result") return "evidence";
  if (event.kind === "task-blocked" || event.kind === "revision-requested" || isFailVerdict(event)) return "blocker";
  return null;
}

export function syncCanvasCollaborationMailboxFromTaskFeedback(
  mailbox: CanvasCollaborationMailbox,
  task: BridgeTask | null | undefined,
): CanvasCollaborationMailbox {
  let next = mailbox;
  for (const event of task?.feedbackEvents ?? []) {
    const kind = messageKindForFeedback(event);
    const assignee = feedbackAssignee(event);
    if (!kind || !assignee) continue;
    next = appendCanvasCollaborationMessage(next, {
      id: `swarm-feedback:${event.id}`,
      assignee,
      kind,
      author: event.actor,
      body: event.summary,
      now: event.at,
      evidence: feedbackEvidence(event.payload),
    });
  }
  return next;
}
