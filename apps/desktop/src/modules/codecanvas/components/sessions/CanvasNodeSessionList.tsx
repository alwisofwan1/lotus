"use client";
import type { CanvasSessionRecord } from "../../services/session-record";
import { CanvasSessionList, type SessionListConfirm, type SessionNeedsYou } from "./CanvasSessionList";

export interface CanvasNodeSessionListProps {
  sessions: CanvasSessionRecord[];
  /** The node's handle, used to name the list. */
  agentName?: string;
  /** The conversation this node is in right now, marked so the list says where you are. */
  activeSessionId?: string | null;
  loading?: boolean;
  /** Injected so relative ages are deterministic under test. */
  now?: number;
  onTogglePinned: (session: CanvasSessionRecord, pinned: boolean) => void;
  /**
   * Switch this node to another conversation. Absent while the node cannot be relaunched, which
   * keeps rows unpressable rather than pressable-and-silent.
   */
  onSelect?: (session: CanvasSessionRecord) => void;
  /** Start a fresh conversation on this node, keeping its identity. */
  onNewSession?: () => void;
  /** Set while this node is waiting on a human; marks its current conversation. */
  needsYou?: SessionNeedsYou | null;
  /** A switch waiting on an answer, asked inside the pressed row. */
  confirm?: SessionListConfirm | null;
  /** Set while the node is being relaunched, so the list cannot be asked twice mid-move. */
  busy?: boolean;
  onClose: () => void;
}

/**
 * One node's own conversations, opened from its header chip (`plans/codecanvas-session-widget/`,
 * Slices 03 and 04) — the same list as the project one, scoped to this node.
 *
 * Selecting a row switches the node to that conversation, and "New conversation" starts a fresh
 * one on the same node — both are the same runtime move (kill the CLI, launch it again with
 * different arguments), so both are absent together when the node cannot be relaunched.
 */
export function CanvasNodeSessionList({
  sessions,
  agentName,
  activeSessionId,
  loading = false,
  now,
  onTogglePinned,
  onSelect,
  onNewSession,
  busy = false,
  needsYou,
  confirm,
  onClose,
}: CanvasNodeSessionListProps) {
  const label = agentName ? `${agentName}'s sessions` : "This node's sessions";
  return (
    <CanvasSessionList
      className="canvas-session-list--node"
      sessions={sessions}
      label={label}
      searchPlaceholder={`Search ${label}`}
      scopeLabel={agentName}
      loading={loading}
      now={now}
      currentSessionId={activeSessionId}
      needsYou={needsYou ? (session) => (session.id === activeSessionId ? needsYou : undefined) : undefined}
      confirm={confirm}
      // The conversation the node is already in has nothing to switch to, and a dead one cannot be
      // resumed — both stay readable, neither is pressable.
      canOpen={(session) =>
        Boolean(onSelect) && !busy && session.id !== activeSessionId && session.status !== "dead"
      }
      onOpen={(session) => onSelect?.(session)}
      onNewConversation={onNewSession && !busy ? onNewSession : undefined}
      onTogglePinned={onTogglePinned}
      emptyText="No sessions on this node yet."
      onClose={onClose}
    />
  );
}
