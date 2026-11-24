"use client";

import { useId, useState } from "react";
import { Trash2 } from "lucide-react";
import { TasksModal } from "@/modules/tasks/components/TasksModal";
import type { NotionRow, WriteOutcome } from "@/modules/tasks/services/notion-source";

/**
 * "Move TKT-1000 to trash?" (mockup `SOURCES 07`, PLAN S45–S46). Always asked: the ticket goes to
 * Notion's trash, never away for good, and its sub-tickets stay where they are — the dialog says both.
 * Only `saved` closes it; any other answer is said here and the ticket stays.
 */
export function TrashTicketDialog({
  row,
  boardName,
  subTickets,
  onConfirm,
  onDone,
  onClose,
}: {
  row: NotionRow;
  boardName: string;
  subTickets: number;
  onConfirm: () => Promise<WriteOutcome>;
  onDone: (row: NotionRow) => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = row.key ?? "this ticket";

  const confirm = () => {
    setBusy(true);
    setError(null);
    void onConfirm()
      .then((outcome) => {
        if (outcome.outcome === "saved") return onDone(outcome.row);
        setError("message" in outcome ? outcome.message : "It was changed in Notion since you opened it. Open it again.");
      })
      .catch((cause) => setError(String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    // Not dismissable while the request is out: closing it would not stop the trash, only hide it.
    <TasksModal labelledBy={headingId} onClose={busy ? () => undefined : onClose} className="tk-trash">
      <div className="tk-add-source-body">
        <h2 className="tk-add-source-title" id={headingId}>
          Move {name} to trash?
        </h2>
        <p className="tk-trash-sub">
          {row.title || "Untitled"} · {boardName}
        </p>
        <p className="tk-trash-explain">
          It goes to the trash in Notion, not away for good. Undo right after, or restore it later from Notion’s trash.
        </p>
        {subTickets > 0 ? (
          <p className="tk-callout tk-callout--conflict tk-trash-subs">
            It has {subTickets} sub-{subTickets === 1 ? "ticket" : "tickets"}. They stay as they are — only {name} moves to
            trash.
          </p>
        ) : null}
        {error ? (
          <p className="tk-callout tk-callout--blocked" role="alert">
            {error}
          </p>
        ) : null}
        <div className="tk-add-notion-foot">
          <button type="button" className="tk-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="tk-button tk-button--destructive" onClick={confirm} disabled={busy} autoFocus>
            <Trash2 size={13} strokeWidth={1.75} aria-hidden />
            Move to trash
          </button>
        </div>
      </div>
    </TasksModal>
  );
}
