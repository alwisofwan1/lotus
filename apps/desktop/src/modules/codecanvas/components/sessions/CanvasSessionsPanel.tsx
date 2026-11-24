"use client";
import { useCallback, useMemo } from "react";
import type { CanvasSessionRecord } from "../../services/session-record";
import { sessionsForProjectList } from "../../services/session-view";
import { planSessionDispatch, type SessionBoardFacts } from "../../services/session-dispatch";
import { CanvasSessionList, type SessionListConfirm, type SessionNeedsYou } from "./CanvasSessionList";

export interface CanvasSessionsPanelProps {
  sessions: CanvasSessionRecord[];
  loading: boolean;
  error: string | null;
  /** Node handles by id, for rows whose node is still on the board. */
  agentNames?: Record<string, string | undefined>;
  /** Injected so relative ages are deterministic under test. */
  now?: number;
  /**
   * Press a row. One entry point for every row, because deciding what a press means is the
   * dispatcher's job and not the panel's (`plans/codecanvas-session-refactor/issues/03`).
   */
  onDispatchSession: (session: CanvasSessionRecord) => void;
  /** Facts about the canvas being looked at, so a row knows whether it can be acted on. */
  board: SessionBoardFacts;
  onTogglePinned?: (session: CanvasSessionRecord, pinned: boolean) => void;
  /** Agents waiting on a human, by node id — marks the conversation each one is in. */
  needsYouByNode?: ReadonlyMap<string, SessionNeedsYou>;
  /** A switch waiting on an answer, asked inside the pressed row. */
  confirm?: SessionListConfirm | null;
  /** Forget a stored conversation (Lotus's record only — `services/session-delete.ts`). */
  onDeleteSession?: (session: CanvasSessionRecord) => void;
  onUndoDelete?: () => void;
  pendingDelete?: CanvasSessionRecord | null;
  onClose: () => void;
}

/**
 * Every conversation in the project, opened from the ⋯ menu (`plans/codecanvas-session-widget/`,
 * Slices 02 and 04; one list since 2026-11-13).
 */
export function CanvasSessionsPanel({
  sessions,
  loading,
  error,
  agentNames,
  now,
  onDispatchSession,
  board,
  onTogglePinned,
  needsYouByNode,
  confirm,
  onDeleteSession,
  onUndoDelete,
  pendingDelete,
  onClose,
}: CanvasSessionsPanelProps) {
  const rows = useMemo(() => sessionsForProjectList(sessions), [sessions]);
  const agentName = useCallback(
    (session: CanvasSessionRecord) => (session.nodeId ? agentNames?.[session.nodeId] : undefined),
    [agentNames],
  );
  const needsYou = useCallback(
    (session: CanvasSessionRecord) =>
      session.status === "live" && session.nodeId && board.activeSessionId(session.nodeId) === session.id
        ? needsYouByNode?.get(session.nodeId)
        : undefined,
    [needsYouByNode, board],
  );
  return (
    <CanvasSessionList
      className="canvas-session-list--project"
      sessions={rows}
      label="Sessions"
      searchPlaceholder="Search sessions"
      scopeLabel="All agents"
      loading={loading}
      error={error}
      now={now}
      agentName={agentName}
      needsYou={needsYouByNode?.size ? needsYou : undefined}
      confirm={confirm}
      // Only a conversation the runner has genuinely lost is dead on the page. Every other refusal
      // is still worth a press, because pressing it is what produces the sentence explaining it
      // (`plans/codecanvas-session-refactor/issues/02`).
      canOpen={(session) => {
        const plan = planSessionDispatch(session, board);
        return !(plan.kind === "blocked" && plan.reason === "dead-session");
      }}
      onOpen={onDispatchSession}
      onTogglePinned={onTogglePinned}
      onDelete={onDeleteSession}
      onUndoDelete={onUndoDelete}
      pendingDelete={pendingDelete}
      emptyText="No sessions in this project yet."
      onClose={onClose}
    />
  );
}
