"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { TasksModal } from "@/modules/tasks/components/TasksModal";
import { MatchNotesChoice, mappedStatus, NotionFieldsEditor, NotionPermissionChoice, remappedFields } from "@/modules/tasks/components/NotionFieldsEditor";
import { TicketSourceMark } from "@/modules/tasks/components/TicketSourceMark";
import type {
  DataSourceSchema,
  FieldMapping,
  NotionSourceClient,
  NotionSourceConfig,
} from "@/modules/tasks/services/notion-source";

/**
 * "Fields of <board>": change which property is which ticket field, any time — and the way out of
 * "Fields changed" (PLAN S19, SOURCES 06's Remap fields). The board is read again first, so the form
 * shows its fields as Notion has them now. Saving changes the mapping, which reads the board again
 * in full; a mapping that fits leaves the source healthy.
 */
export function NotionFieldsSheet({
  source,
  client,
  notesName,
  notesMark,
  onSave,
  onClose,
}: {
  source: NotionSourceConfig;
  client: NotionSourceClient;
  /** The notes this board's tickets could be matched with by key, or absent when there are none. */
  notesName?: string | null;
  notesMark?: ReactNode;
  onSave: (source: NotionSourceConfig) => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const [schema, setSchema] = useState<DataSourceSchema | null>(null);
  const [mapping, setMapping] = useState<FieldMapping | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [permission, setPermission] = useState(source.permission);
  const [matchNotes, setMatchNotes] = useState(source.matchNotes === true);

  /*
    Read once per board, with the mapping as it was when the sheet opened. The settings rebuild
    every source object on each change anywhere; following that identity would re-read Notion and
    throw away what the person has picked so far.
  */
  const [opened] = useState(source);
  useEffect(() => {
    let cancelled = false;
    void client
      .describe(opened.dataSourceId)
      .then((described) => {
        if (cancelled) return;
        setSchema(described.schema);
        setMapping(remappedFields(opened.mapping, described.schema, described.mapping));
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [client, opened]);

  const save = () => {
    if (!schema || !mapping?.title) return;
    const { matchNotes: before, ...rest } = source;
    // With no notes on this machine the choice is not shown, and what was chosen before is kept.
    const match = notesName ? matchNotes : before === true;
    onSave({ ...rest, mapping, statuses: mappedStatus(schema, mapping), permission, ...(match ? { matchNotes: true } : {}) });
  };

  return (
    <TasksModal labelledBy={headingId} onClose={onClose} size="lg" className="tk-add-notion">
      <div className="tk-add-source-body">
        <h2 className="tk-add-source-title" id={headingId}>
          <TicketSourceMark kind="notion" size={15} />
          Fields of {source.name}
        </h2>
        {error ? (
          <p className="tk-error" role="alert">{error}</p>
        ) : !schema || !mapping ? (
          <p className="tk-add-notion-note">Reading the database’s fields…</p>
        ) : (
          <>
            <NotionFieldsEditor schema={schema} mapping={mapping} onChange={setMapping} />
            <NotionPermissionChoice value={permission} onChange={setPermission} />
          </>
        )}
        <div className="tk-add-notion-foot">
          {notesName && schema ? (
            <MatchNotesChoice notesName={notesName} mark={notesMark} checked={matchNotes} onChange={setMatchNotes} />
          ) : null}
          <button type="button" className="tk-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="tk-button tk-button--primary" disabled={!schema || !mapping?.title} onClick={save}>
            Save fields
          </button>
        </div>
      </div>
    </TasksModal>
  );
}
