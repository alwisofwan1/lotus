"use client";

import { useMemo, useState, type FormEvent } from "react";
import type { BridgeTask, BridgeTaskFeedbackEvent, BridgeTaskStatus, BridgePriority } from "@/lib/tauri-api";
import type { CanvasCollaborationLaunch } from "../services/canvas-collaboration-launch";
import type { CanvasCollaborationAssignmentState } from "../services/collaboration/canvas-collaboration-ledger";
import type { CanvasCollaborationMailboxMessage } from "../services/collaboration/canvas-collaboration-mailbox";
import type { CanvasCollaborationParticipantStatus, CanvasCollaborationParticipantView } from "../services/collaboration/canvas-collaboration-participants";
import type { CanvasCollaborationStorageStatus } from "../services/collaboration/canvas-collaboration-store-events";

export type CanvasCollaborationParticipant = CanvasCollaborationParticipantView;

export interface CanvasCollaborationRecordEvidenceInput {
  assignee: string;
  nodeId?: string;
  summary: string;
  files?: string[];
  checks?: string[];
}

export interface CanvasCollaborationMarkBlockedInput {
  assignee: string;
  nodeId?: string;
  summary: string;
  blockers?: string[];
}

export interface CanvasCollaborationRunOverlayProps {
  launch: CanvasCollaborationLaunch;
  participants: CanvasCollaborationParticipant[];
  task?: BridgeTask | null;
  taskLoading?: boolean;
  taskError?: string | null;
  mailboxMessages?: CanvasCollaborationMailboxMessage[];
  storageStatus?: CanvasCollaborationStorageStatus;
  projectId?: string | null;
  runId?: string | null;
  onSpawnMissing?: () => void;
  onFocusParticipant?: (nodeId: string) => void;
  onRecordEvidence?: (input: CanvasCollaborationRecordEvidenceInput) => void;
  onMarkBlocked?: (input: CanvasCollaborationMarkBlockedInput) => void;
}

const STATUS_LABEL: Record<CanvasCollaborationParticipantStatus, string> = {
  "not-spawned": "Not spawned",
  queued: "Queued",
  starting: "Starting",
  running: "Running",
  done: "Done",
  "needs-attention": "Needs attention",
};

const ASSIGNMENT_LABEL: Record<CanvasCollaborationAssignmentState, string> = {
  spawned: "Spawned",
  assigned: "Assigned",
  running: "Running",
  done: "Done",
  blocked: "Blocked",
};

function visibleStatus(participants: CanvasCollaborationParticipant[]): string {
  if (participants.some((p) => p.status === "needs-attention")) return "Needs action";
  if (participants.some((p) => p.status === "running" || p.status === "starting")) return "Running";
  if (participants.some((p) => p.status === "done")) return "Results ready";
  return "Ready";
}

const TASK_STATUS_LABEL: Record<BridgeTaskStatus, string> = {
  "todo": "Todo",
  "in-progress": "In progress",
  "blocked": "Blocked",
  "in-review": "In review",
  "complete": "Complete",
  "cancelled": "Cancelled",
};

const PRIORITY_LABEL: Record<BridgePriority, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
};

function participantTone(status: CanvasCollaborationParticipantStatus): string {
  if (status === "needs-attention") return "danger";
  if (status === "running" || status === "starting") return "active";
  if (status === "done") return "done";
  if (status === "not-spawned") return "missing";
  return "idle";
}

/**
 * Lightweight run-context overlay for CodeCanvas. It is intentionally absent on
 * ordinary canvas routes; Swarm task/workflow launches opt in through the URL.
 * The full ledger can grow behind this seam without making normal canvases noisy.
 */
function latestEvents(events: BridgeTaskFeedbackEvent[] | undefined, limit = 4): BridgeTaskFeedbackEvent[] {
  return [...(events ?? [])].sort((a, b) => b.at - a.at).slice(0, limit);
}

function latestMailboxMessages(messages: CanvasCollaborationMailboxMessage[] | undefined, limit = 4): CanvasCollaborationMailboxMessage[] {
  return [...(messages ?? [])].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

function mailboxKindLabel(kind: CanvasCollaborationMailboxMessage["kind"]): string {
  return kind.replace(/-/g, " ");
}

function normalizeParticipantName(name: string): string {
  return name.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function messagesForParticipant(messages: CanvasCollaborationMailboxMessage[] | undefined, participant: CanvasCollaborationParticipant): CanvasCollaborationMailboxMessage[] {
  const participantKey = normalizeParticipantName(participant.name);
  return [...(messages ?? [])]
    .filter((message) => (participant.nodeId && message.nodeId === participant.nodeId) || message.assigneeKey === participantKey)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function storageStatusLabel(status: CanvasCollaborationStorageStatus): string {
  switch (status) {
    case "project-synced":
      return "Project synced";
    case "local-fallback":
      return "Local fallback";
    case "mcp-updated":
      return "Updated by MCP";
  }
}

function messageEvidenceLines(message: CanvasCollaborationMailboxMessage): string[] {
  return [
    ...(message.evidence?.files?.length ? [`Files: ${message.evidence.files.join(", ")}`] : []),
    ...(message.evidence?.checks?.length ? [`Checks: ${message.evidence.checks.join(", ")}`] : []),
    ...(message.evidence?.blockers?.length ? [`Blockers: ${message.evidence.blockers.join(", ")}`] : []),
  ];
}

type ComposerKind = "evidence" | "blocker";

interface ComposerState {
  participantId: string;
  kind: ComposerKind;
  summary: string;
  files: string;
  checks: string;
  blockers: string;
}

function splitCommaList(value: string): string[] | undefined {
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function CanvasCollaborationRunOverlay({ launch, participants, task, taskLoading = false, taskError = null, mailboxMessages, storageStatus, projectId, runId, onSpawnMissing, onFocusParticipant, onRecordEvidence, onMarkBlocked }: CanvasCollaborationRunOverlayProps) {
  const launchKey = launch.mode === "off"
    ? "off"
    : `${launch.mode}:${launch.taskId ?? ""}:${launch.workflowId ?? ""}`;
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(() => new Set());
  const [forcedOpenKeys, setForcedOpenKeys] = useState<Set<string>>(() => new Set());
  const [expandedParticipantIds, setExpandedParticipantIds] = useState<Set<string>>(() => new Set());
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const summary = useMemo(() => {
    if (launch.mode === "off") return null;
    const details = [launch.taskId ? `Task ${launch.taskId}` : null, launch.workflowId ? `Workflow ${launch.workflowId}` : null].filter(Boolean);
    return details.length > 0 ? details.join(" · ") : "Collaboration run";
  }, [launch]);

  if (launch.mode === "off") return null;

  const open = forcedOpenKeys.has(launchKey) || (launch.autoOpenPanel && !dismissedKeys.has(launchKey));
  const setKeyDismissed = (dismissed: boolean) => {
    setDismissedKeys((prev) => {
      const next = new Set(prev);
      if (dismissed) next.add(launchKey); else next.delete(launchKey);
      return next;
    });
    setForcedOpenKeys((prev) => {
      const next = new Set(prev);
      if (dismissed) next.delete(launchKey); else next.add(launchKey);
      return next;
    });
  };
  const status = visibleStatus(participants);
  const participantCount = participants.length;
  const missingCount = participants.filter((participant) => participant.status === "not-spawned" && participant.source === "task-assignee").length;
  const visibleMailboxMessages = latestMailboxMessages(mailboxMessages);
  const hasMcpContext = Boolean(projectId && runId);
  const mcpContextText = hasMcpContext ? [
    "CodeCanvas collaboration MCP context",
    `projectId: ${projectId}`,
    `runId: ${runId}`,
    "",
    "Example:",
    `lotus_canvas_list_participants({ projectId: ${JSON.stringify(projectId)}, runId: ${JSON.stringify(runId)} })`,
    `lotus_canvas_read_assignment({ projectId: ${JSON.stringify(projectId)}, runId: ${JSON.stringify(runId)}, assignee: \"<assignee>\" })`,
    `lotus_canvas_record_evidence({ projectId: ${JSON.stringify(projectId)}, runId: ${JSON.stringify(runId)}, assignee: \"<assignee>\", summary: \"...\", files: [], checks: [] })`,
  ].join("\n") : "";
  const toggleParticipantDetails = (participantId: string) => {
    setExpandedParticipantIds((prev) => {
      const next = new Set(prev);
      if (next.has(participantId)) next.delete(participantId); else next.add(participantId);
      return next;
    });
  };
  const copyMcpContext = () => {
    if (!mcpContextText || typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setCopyState("failed");
      return;
    }
    void navigator.clipboard.writeText(mcpContextText)
      .then(() => setCopyState("copied"))
      .catch(() => setCopyState("failed"));
  };
  const openComposer = (participantId: string, kind: ComposerKind) => {
    setComposer({ participantId, kind, summary: "", files: "", checks: "", blockers: "" });
  };
  const submitComposer = (event: FormEvent<HTMLFormElement>, participant: CanvasCollaborationParticipant) => {
    event.preventDefault();
    if (!composer || composer.participantId !== participant.id || !composer.summary.trim()) return;
    if (composer.kind === "evidence") {
      onRecordEvidence?.({
        assignee: participant.name,
        ...(participant.nodeId ? { nodeId: participant.nodeId } : {}),
        summary: composer.summary.trim(),
        ...(splitCommaList(composer.files) ? { files: splitCommaList(composer.files) } : {}),
        ...(splitCommaList(composer.checks) ? { checks: splitCommaList(composer.checks) } : {}),
      });
    } else {
      onMarkBlocked?.({
        assignee: participant.name,
        ...(participant.nodeId ? { nodeId: participant.nodeId } : {}),
        summary: composer.summary.trim(),
        ...(splitCommaList(composer.blockers) ? { blockers: splitCommaList(composer.blockers) } : {}),
      });
    }
    setComposer(null);
  };

  return (
    <div className="canvas-collab-run" data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="canvas-collab-chip"
        aria-label="Toggle collaboration ledger"
        aria-expanded={open}
        onClick={() => setKeyDismissed(open)}
      >
        <span className="canvas-collab-chip-dot" aria-hidden />
        <span className="canvas-collab-chip-source">{launch.sourceLabel}</span>
        <span className="canvas-collab-chip-status">{status}</span>
      </button>

      {open ? (
        <aside className="canvas-collab-panel" role="complementary" aria-label="Collaboration ledger">
          <div className="canvas-collab-panel-head">
            <div>
              <div className="canvas-collab-eyebrow">Collaboration ledger</div>
              <h2>{launch.sourceLabel}</h2>
              {summary ? <p>{summary}</p> : null}
              {storageStatus ? <div className="canvas-collab-sync-chip" data-status={storageStatus}>{storageStatusLabel(storageStatus)}</div> : null}
            </div>
            <button type="button" className="canvas-collab-close" aria-label="Close collaboration ledger" onClick={() => setKeyDismissed(true)}>
              ×
            </button>
          </div>

          <div className="canvas-collab-section">
            <div className="canvas-collab-section-title">Task context</div>
            {taskLoading ? <p className="canvas-collab-empty">Loading Swarm task…</p> : null}
            {taskError ? <p className="canvas-collab-empty">{taskError}</p> : null}
            {task ? (
              <div className="canvas-collab-task-card">
                <div className="canvas-collab-task-title">{task.title}</div>
                <p className="canvas-collab-copy">{task.goal}</p>
                <div className="canvas-collab-tags">
                  <span>{TASK_STATUS_LABEL[task.status]}</span>
                  <span>{PRIORITY_LABEL[task.priority]}</span>
                  {task.assignees.map((assignee) => <span key={assignee}>{assignee}</span>)}
                </div>
              </div>
            ) : !taskLoading && !taskError ? (
              <p className="canvas-collab-empty">Swarm task details will appear here when the task can be resolved.</p>
            ) : null}
          </div>

          <div className="canvas-collab-section">
            <div className="canvas-collab-section-title">Recent assignment events <span>{task?.feedbackEvents?.length ?? 0}</span></div>
            {task && latestEvents(task.feedbackEvents).length > 0 ? (
              <div className="canvas-collab-events">
                {latestEvents(task.feedbackEvents).map((event) => (
                  <div className="canvas-collab-event" key={event.id}>
                    <span className="canvas-collab-event-actor">{event.actor}</span>
                    <span className="canvas-collab-event-summary">{event.summary}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="canvas-collab-empty">No assignment feedback has been recorded yet.</p>
            )}
          </div>

          {visibleMailboxMessages.length > 0 ? (
            <div className="canvas-collab-section">
              <div className="canvas-collab-section-title">Assignment mailbox <span>{mailboxMessages?.length ?? 0}</span></div>
              <div className="canvas-collab-events">
                {visibleMailboxMessages.map((message) => (
                  <div className="canvas-collab-event" key={message.id}>
                    <span className="canvas-collab-event-actor">{mailboxKindLabel(message.kind)}</span>
                    <span className="canvas-collab-event-summary">
                      {message.assignee}: {message.body}
                      {messageEvidenceLines(message).map((line) => <small key={line}>{line}</small>)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="canvas-collab-section">
            <div className="canvas-collab-section-title">Delivery model</div>
            <p className="canvas-collab-copy">
              Agent nodes stay headless. Assignments and messages are tracked here, while live terminal sessions only deliver or inspect work when needed.
            </p>
          </div>

          {hasMcpContext ? (
            <div className="canvas-collab-section canvas-collab-mcp-context">
              <div className="canvas-collab-section-title">MCP context</div>
              <p className="canvas-collab-copy">Use these ids when an agent needs to read or update this run after Canvas is closed.</p>
              <dl className="canvas-collab-context-list">
                <div>
                  <dt>projectId</dt>
                  <dd>{projectId}</dd>
                </div>
                <div>
                  <dt>runId</dt>
                  <dd>{runId}</dd>
                </div>
              </dl>
              <button type="button" className="canvas-collab-action" aria-label="Copy MCP context" onClick={copyMcpContext}>
                {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy unavailable" : "Copy MCP context"}
              </button>
            </div>
          ) : null}

          <div className="canvas-collab-section">
            <div className="canvas-collab-section-title">Participants <span>{participantCount}</span></div>
            {missingCount > 0 && onSpawnMissing ? (
              <button type="button" className="canvas-collab-action" onClick={onSpawnMissing}>
                Spawn missing agents
              </button>
            ) : null}
            {participants.length > 0 ? (
              <div className="canvas-collab-participants">
                {participants.map((participant) => {
                  const participantMessages = messagesForParticipant(mailboxMessages, participant);
                  const detailsOpen = expandedParticipantIds.has(participant.id);
                  return (
                    <div className="canvas-collab-participant-group" key={participant.id}>
                      <div className="canvas-collab-participant" data-tone={participantTone(participant.status)}>
                        <span className="canvas-collab-participant-dot" aria-hidden />
                        <span className="canvas-collab-participant-name">
                          {participant.name}
                          {participant.lastEventSummary ? <small>{participant.lastEventSummary}</small> : null}
                          {participant.assignmentBriefSent ? <small>Brief sent</small> : null}
                        </span>
                        <span className="canvas-collab-participant-status">
                          {STATUS_LABEL[participant.status]}
                          {participant.assignmentState ? <small>Ledger: {ASSIGNMENT_LABEL[participant.assignmentState]}</small> : null}
                          {participant.evidenceCount > 0 ? <small>{participant.evidenceCount} evidence</small> : null}
                        </span>
                        <button
                          type="button"
                          className="canvas-collab-participant-action"
                          aria-expanded={detailsOpen}
                          aria-label={`${detailsOpen ? "Hide" : "Show"} ${participant.name} details`}
                          onClick={() => toggleParticipantDetails(participant.id)}
                        >
                          Details
                        </button>
                        {participant.nodeId && onFocusParticipant ? (
                          <button
                            type="button"
                            className="canvas-collab-participant-action"
                            aria-label={`Focus ${participant.name}`}
                            onClick={() => onFocusParticipant(participant.nodeId as string)}
                          >
                            Focus
                          </button>
                        ) : null}
                      </div>
                      {detailsOpen ? (
                        <div className="canvas-collab-participant-thread" role="region" aria-label={`${participant.name} assignment thread`}>
                          <div className="canvas-collab-thread-title">Assignment thread <span>{participantMessages.length}</span></div>
                          {(onRecordEvidence || onMarkBlocked) ? (
                            <div className="canvas-collab-thread-actions">
                              {onRecordEvidence ? (
                                <button type="button" className="canvas-collab-thread-action" aria-label={`Record evidence for ${participant.name}`} onClick={() => openComposer(participant.id, "evidence")}>
                                  Record evidence
                                </button>
                              ) : null}
                              {onMarkBlocked ? (
                                <button type="button" className="canvas-collab-thread-action" aria-label={`Mark ${participant.name} blocked`} onClick={() => openComposer(participant.id, "blocker")}>
                                  Mark blocked
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                          {composer?.participantId === participant.id ? (
                            <form className="canvas-collab-composer" onSubmit={(event) => submitComposer(event, participant)}>
                              <label>
                                {composer.kind === "evidence" ? "Evidence summary" : "Blocker summary"}
                                <textarea
                                  value={composer.summary}
                                  onChange={(event) => setComposer({ ...composer, summary: event.target.value })}
                                  rows={3}
                                />
                              </label>
                              {composer.kind === "evidence" ? (
                                <>
                                  <label>
                                    Files touched
                                    <input value={composer.files} onChange={(event) => setComposer({ ...composer, files: event.target.value })} />
                                  </label>
                                  <label>
                                    Checks run
                                    <input value={composer.checks} onChange={(event) => setComposer({ ...composer, checks: event.target.value })} />
                                  </label>
                                </>
                              ) : (
                                <label>
                                  Blocker details
                                  <input value={composer.blockers} onChange={(event) => setComposer({ ...composer, blockers: event.target.value })} />
                                </label>
                              )}
                              <div className="canvas-collab-composer-actions">
                                <button type="button" onClick={() => setComposer(null)}>Cancel</button>
                                <button type="submit">{composer.kind === "evidence" ? "Save evidence" : "Save blocker"}</button>
                              </div>
                            </form>
                          ) : null}
                          {participantMessages.length > 0 ? (
                            <div className="canvas-collab-thread-messages">
                              {participantMessages.map((message) => (
                                <div className="canvas-collab-thread-message" key={message.id} data-kind={message.kind}>
                                  <div className="canvas-collab-thread-message-head">
                                    <span>{mailboxKindLabel(message.kind)}</span>
                                    <small>{message.author}</small>
                                  </div>
                                  <p>{message.body}</p>
                                  {messageEvidenceLines(message).map((line) => <small key={line}>{line}</small>)}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="canvas-collab-empty">No mailbox messages for this participant yet.</p>
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="canvas-collab-empty">Workflow nodes are loading. Participants appear when Agent nodes are present on the canvas.</p>
            )}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
