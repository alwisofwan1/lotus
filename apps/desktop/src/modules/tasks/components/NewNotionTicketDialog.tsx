"use client";

import { useId, useState } from "react";
import { TasksModal } from "@/modules/tasks/components/TasksModal";
import { TicketSourceMark } from "@/modules/tasks/components/TicketSourceMark";
import type { NotionRow, WriteOutcome } from "@/modules/tasks/services/notion-source";

/**
 * "New task" on a Manage Notion board (PLAN S49): a title, and the ticket is made in that database,
 * in its first To-do status, with the key Notion gives it. The body is added after, in Notion or on
 * the ticket's page.
 */
export function NewNotionTicketDialog({
  boardName,
  onCreate,
  onDone,
  onClose,
  onRefresh,
}: {
  boardName: string;
  /** Reads the board again — the way out after an answer that may have created the ticket. */
  onRefresh: () => void;
  onCreate: (title: string) => Promise<WriteOutcome>;
  onDone: (row: NotionRow) => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After an answer that may have created it, no second send: that could make a duplicate (S33).
  const [mustRefresh, setMustRefresh] = useState(false);

  const create = () => {
    if (busy || mustRefresh || !title.trim()) return;
    setBusy(true);
    setError(null);
    void onCreate(title.trim())
      .then((outcome) => {
        if (outcome.outcome === "saved") return onDone(outcome.row);
        if (outcome.outcome === "unknown") setMustRefresh(true);
        setError("message" in outcome ? outcome.message : "Notion did not create it.");
      })
      .catch((cause) => setError(String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    // Not dismissable while the request is out: closing would not stop the create, only hide it.
    <TasksModal labelledBy={headingId} onClose={busy ? () => undefined : onClose}>
      <form
        className="tk-add-source-body"
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <h2 className="tk-add-source-title" id={headingId}>
          <TicketSourceMark kind="notion" size={15} />
          New ticket in {boardName}
        </h2>
        <input
          className="tk-new-ticket-input"
          aria-label="Title"
          placeholder="Ticket title"
          autoFocus
          value={title}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />
        <p className="tk-add-notion-note">Starts in the board’s first To-do status. Notion gives the key when it saves.</p>
        {error ? (
          <p className="tk-callout tk-callout--blocked" role="alert">
            {error}
          </p>
        ) : null}
        <div className="tk-add-notion-foot">
          <button type="button" className="tk-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {mustRefresh ? (
            <button
              type="button"
              className="tk-button tk-button--primary"
              onClick={() => {
                onRefresh();
                onClose();
              }}
            >
              Refresh board
            </button>
          ) : (
            <button type="submit" className="tk-button tk-button--primary" disabled={busy || !title.trim()}>
              Create ticket
            </button>
          )}
        </div>
      </form>
    </TasksModal>
  );
}
