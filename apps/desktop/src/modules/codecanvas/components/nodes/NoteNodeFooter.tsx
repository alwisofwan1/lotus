"use client";
import { memo, useMemo } from "react";
import { useNodeConnections, useNodesData } from "@xyflow/react";
import { Bot, ListChecks, SquareTerminal } from "lucide-react";
import { formatNoteEditedAt } from "../../services/nodes/note-title";
import { terminalDisplayName } from "../../services/terminal/terminal-node-identity";

interface Props {
  nodeId: string;
  /** Checklist progress — computed once by NoteNode, which also feeds it to the zoomed-out card. */
  progress: { done: number; total: number };
  editedAt?: number;
  /** The agent that wrote the last change, if one did. */
  editedBy?: string;
}

interface LinkedNode {
  kind: "agent" | "terminal";
  name: string;
}

/**
 * The first agent (else terminal) wired to this note, named the way its own header names it.
 * Other node kinds on a wire (another note, a browser) are not "who this note is for", so they
 * are skipped.
 */
function useLinkedNode(nodeId: string): LinkedNode | null {
  const connections = useNodeConnections({ id: nodeId });
  const peerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const connection of connections) ids.add(connection.source === nodeId ? connection.target : connection.source);
    return [...ids];
  }, [connections, nodeId]);
  const peers = useNodesData(peerIds);

  return useMemo(() => {
    const agent = peers.find((peer) => peer.type === "agent");
    if (agent) {
      const name = (agent.data as { name?: unknown }).name;
      return { kind: "agent", name: typeof name === "string" && name.trim() ? name.trim() : "agent" };
    }
    const terminal = peers.find((peer) => peer.type === "terminal");
    if (terminal) return { kind: "terminal", name: terminalDisplayName(terminal.data as { label?: unknown; terminalNumber?: unknown }) };
    return null;
  }, [peers]);
}

/**
 * The note's one quiet footer (ADR-0046): who the note is linked to, when it was last edited, and
 * checklist progress. It replaces the header's old meta slot. Each part shows only when it has
 * something to say, and the whole footer disappears when none does — an empty rule under a short
 * note is noise.
 */
export const NoteNodeFooter = memo(function NoteNodeFooter({ nodeId, progress, editedAt, editedBy }: Props) {
  const linked = useLinkedNode(nodeId);
  const edited = editedAt ? formatNoteEditedAt(editedAt, undefined, editedBy) : null;

  if (!linked && !edited && progress.total === 0) return null;

  return (
    <div className="canvas-note-footer">
      {linked && (
        <span className="cnf-avatar" data-kind={linked.kind} aria-hidden>
          {linked.kind === "agent" ? <Bot size={15} /> : <SquareTerminal size={14} />}
        </span>
      )}
      <div className="cnf-meta">
        {linked && <span className="cnf-linked">Linked to {linked.name}</span>}
        {edited && <span className="cnf-edited">{edited}</span>}
      </div>
      {progress.total > 0 && (
        <span
          className="cnf-progress"
          data-complete={progress.done === progress.total || undefined}
          aria-label={`${progress.done} of ${progress.total} tasks done`}
        >
          <ListChecks size={12} aria-hidden />
          {progress.done} of {progress.total}
        </span>
      )}
    </div>
  );
});
