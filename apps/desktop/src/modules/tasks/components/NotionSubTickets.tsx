"use client";

import { useState } from "react";
import { CornerDownLeft } from "lucide-react";
import { TaskStatusGlyph } from "@/modules/tasks/components/TaskGlyphs";
import type { NotionRow, WriteOutcome } from "@/modules/tasks/services/notion-source";
import { statusLabel, type StatusVocabulary } from "@/modules/tasks/services/task-vocabulary";
import type { BridgeTaskStatus } from "@/modules/codespace/services/bridge/task-store";

/**
 * A main ticket's sub-tickets, and the one-line form that adds another (mockup `SOURCES 09`,
 * PLAN S47–S50).
 *
 * The list is the board's own rows whose Parent names this ticket — the whole board is already
 * read, so it needs no request and no paging past Notion's 25 relations per answer. The form sends
 * only a title: the status is the board's first To-do, the key is Notion's to give.
 */
export interface NotionSubTicketsProps {
  rows: readonly NotionRow[];
  /** `null`: this database cannot add here (Read only). `"unmapped"`: Manage, but no Parent field. */
  add: { onAdd: (title: string) => Promise<WriteOutcome>; boardName: string; onRefresh: () => void } | "unmapped" | null;
  onOpen: (pageId: string) => void;
  /** Set on a sub-ticket: its main ticket, linked from the Properties column. */
  parent?: NotionRow | null;
}

export function NotionSubTickets({
  rows,
  add,
  onOpen,
  vocabulary,
  mainKey,
}: Omit<NotionSubTicketsProps, "parent"> & { vocabulary: StatusVocabulary; mainKey: string | null }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After an answer that may have created it: no second send until the board is read again, or a
  // duplicate could be made (S33). Refresh reads it, and clears the form.
  const [mustRefresh, setMustRefresh] = useState(false);

  // Nothing to list and nothing to add: no section at all.
  if (rows.length === 0 && add === null) return null;

  const submit = () => {
    if (!add || add === "unmapped" || busy || mustRefresh || !title.trim()) return;
    setBusy(true);
    setError(null);
    void add
      .onAdd(title.trim())
      .then((outcome) => {
        if (outcome.outcome === "saved") return setTitle("");
        if (outcome.outcome === "unknown") setMustRefresh(true);
        setError("message" in outcome ? outcome.message : "Notion did not create it.");
      })
      .catch((cause) => setError(String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="tk-detail-section tk-subtickets" aria-label="Sub-tickets">
      <h3 className="tk-detail-h tk-subtickets-h">
        Sub-tickets <span className="tk-subtickets-count">{rows.length}</span>
      </h3>
      {rows.length > 0 ? (
        <ul className="tk-subtickets-list">
          {rows.map((row) => (
            <li key={row.pageId}>
              <button type="button" className="tk-subticket" onClick={() => onOpen(row.pageId)}>
                <span className="tk-subticket-key">{row.key ?? "—"}</span>
                <span className="tk-subticket-title">{row.title || "Untitled"}</span>
                {row.status ? (
                  <span className="tk-subticket-status">
                    <TaskStatusGlyph status={row.status as BridgeTaskStatus} vocabulary={vocabulary} decorative size={12} />
                    {statusLabel(vocabulary, row.status)}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {add === "unmapped" ? (
        <p className="tk-subtickets-hint">Map a Parent field to add sub-tickets</p>
      ) : add ? (
        <>
          <div className="tk-subticket-new" data-busy={busy || undefined}>
            <span className="tk-subticket-key tk-subticket-key--new">{mainKey ? `${mainKey.replace(/-\d+$/, "")}-…` : "…"}</span>
            <input
              className="tk-subticket-input"
              aria-label="New sub-ticket title"
              placeholder="Add a sub-ticket"
              value={title}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <button type="button" className="tk-button" disabled={busy || mustRefresh || !title.trim()} onClick={submit}>
              Add sub-ticket
              <CornerDownLeft size={12} strokeWidth={2} aria-hidden />
            </button>
          </div>
          {error ? (
            <div className="tk-callout tk-callout--blocked tk-subtickets-error" role="alert">
              <span>{error}</span>
              {mustRefresh ? (
                <button
                  type="button"
                  className="tk-button"
                  onClick={() => {
                    add.onRefresh();
                    setTitle("");
                    setError(null);
                    setMustRefresh(false);
                  }}
                >
                  Refresh board
                </button>
              ) : null}
            </div>
          ) : null}
          <p className="tk-subtickets-hint">
            Created in {add.boardName} with Parent = {mainKey ?? "this ticket"}. Notion gives the key when it saves.
          </p>
        </>
      ) : null}
    </section>
  );
}
