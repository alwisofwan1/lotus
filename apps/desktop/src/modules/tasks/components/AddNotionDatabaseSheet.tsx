"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { TasksModal } from "@/modules/tasks/components/TasksModal";
import { MatchNotesChoice, mappedStatus, NotionFieldsEditor, NotionPermissionChoice } from "@/modules/tasks/components/NotionFieldsEditor";
import { TicketSourceMark } from "@/modules/tasks/components/TicketSourceMark";
import type { NotionStatus } from "@/modules/connectors/services/connectors-api";
import {
  notionSourceId,
  type DataSourceSchema,
  type DataSourceSummary,
  type FieldMapping,
  type NotionSourceClient,
  type NotionSourceConfig,
} from "@/modules/tasks/services/notion-source";

/**
 * Add a Notion database (mockup `SOURCES 03`, PLAN S16–S21): pick it, see the fields Lotus found —
 * and change any — see the board's statuses in its own words, and choose what Lotus may change.
 *
 * Read only is the default. The token can always write (research §8), so it is Lotus that keeps a
 * Read only board read only (task "Ticket Sources 09").
 */

/** Long enough that typing a name does not search on every keystroke. */
const SEARCH_DEBOUNCE_MS = 300;

export interface AddNotionDatabaseSheetProps {
  account: NotionStatus;
  client: NotionSourceClient;
  /** Sources already added, so the same database is not added twice. */
  existingIds: ReadonlySet<string>;
  /**
   * The name of the notes a ticket could be matched with by key — the Obsidian vault's — or
   * absent when there are none, and then "Match notes by key" is not offered (PLAN S37).
   */
  notesName?: string | null;
  /** The mark of the place those notes live in. */
  notesMark?: ReactNode;
  onAdd: (source: NotionSourceConfig) => void;
  onClose: () => void;
}

export function AddNotionDatabaseSheet({ account, client, existingIds, notesName, notesMark, onAdd, onClose }: AddNotionDatabaseSheetProps) {
  const headingId = useId();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<DataSourceSummary[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [picked, setPicked] = useState<DataSourceSummary | null>(null);
  const [schema, setSchema] = useState<DataSourceSchema | null>(null);
  const [mapping, setMapping] = useState<FieldMapping | null>(null);
  const [describeError, setDescribeError] = useState<string | null>(null);
  const [permission, setPermission] = useState<NotionSourceConfig["permission"]>("read_only");
  const [matchNotes, setMatchNotes] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void client
        .search(query)
        .then((results) => {
          if (cancelled) return;
          setFound(results);
          setSearchError(null);
        })
        .catch((cause) => {
          if (!cancelled) setSearchError(String(cause));
        });
    }, query ? SEARCH_DEBOUNCE_MS : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, query]);

  useEffect(() => {
    if (!picked) return;
    let cancelled = false;
    void client
      .describe(picked.id)
      .then((described) => {
        if (cancelled) return;
        setSchema(described.schema);
        setMapping(described.mapping);
      })
      .catch((cause) => {
        if (!cancelled) setDescribeError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [client, picked]);

  /** A new pick starts from nothing, so the last database's fields never show under this one's name. */
  const pick = (database: DataSourceSummary) => {
    if (database.id === picked?.id) return;
    setSchema(null);
    setMapping(null);
    setDescribeError(null);
    setPicked(database);
  };

  const statuses = schema && mapping ? mappedStatus(schema, mapping) : null;
  const sourceId = picked ? notionSourceId(picked.id) : null;
  const already = sourceId ? existingIds.has(sourceId) : false;
  const canAdd = Boolean(schema && mapping?.title) && !already;

  const add = () => {
    if (!schema || !mapping || !sourceId || !canAdd) return;
    onAdd({
      id: sourceId,
      kind: "notion",
      name: schema.title || picked?.title || "Notion database",
      dataSourceId: schema.id,
      url: schema.url ?? picked?.url ?? null,
      mapping,
      statuses,
      permission,
      ...(notesName && matchNotes ? { matchNotes: true } : {}),
    });
  };

  const who = [account.name, account.kind === "integration" ? account.workspace : account.email].filter(Boolean).join(" · ");

  return (
    <TasksModal labelledBy={headingId} onClose={onClose} size="lg" className="tk-add-notion">
      <div className="tk-add-source-body">
        <h2 className="tk-add-source-title" id={headingId}>
          <TicketSourceMark kind="notion" size={15} />
          Add a Notion database
        </h2>
        {who ? <p className="tk-add-notion-who">Signed in as {who}</p> : null}

        <section className="tk-add-notion-section" aria-label="Database">
          <h3 className="tk-add-notion-h">Database</h3>
          <label className="tk-add-notion-search">
            <Search size={13} strokeWidth={1.75} aria-hidden />
            <input
              autoFocus
              value={query}
              placeholder="Search your databases"
              aria-label="Search your databases"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {searchError ? <p className="tk-error" role="alert">{searchError}</p> : null}
          {found === null && !searchError ? <p className="tk-add-notion-note">Looking…</p> : null}
          {found && found.length === 0 ? (
            <p className="tk-add-notion-note">
              No database matches. Linked views are not listed — pick the original database.
            </p>
          ) : null}
          {found && found.length > 0 ? (
            <ul className="tk-add-notion-list" role="listbox" aria-label="Databases">
              {found.map((database) => (
                <li key={database.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={picked?.id === database.id}
                    className="tk-add-notion-db"
                    onClick={() => pick(database)}
                  >
                    {database.title || "Untitled database"}
                    {existingIds.has(notionSourceId(database.id)) ? <span className="tk-add-source-badge">Added</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {picked ? (
          describeError ? (
            <p className="tk-error" role="alert">{describeError}</p>
          ) : !schema || !mapping ? (
            <p className="tk-add-notion-note">Reading the database’s fields…</p>
          ) : (
            <>
              <NotionFieldsEditor schema={schema} mapping={mapping} onChange={setMapping} />

              <NotionPermissionChoice value={permission} onChange={setPermission} />
            </>
          )
        ) : null}

        <div className="tk-add-notion-foot">
          {notesName && schema && !already ? (
            <MatchNotesChoice notesName={notesName} mark={notesMark} checked={matchNotes} onChange={setMatchNotes} />
          ) : null}
          {already ? <span className="tk-add-notion-note">This database is already a ticket source.</span> : null}
          <button type="button" className="tk-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="tk-button tk-button--primary" disabled={!canAdd} onClick={add}>
            {schema ? `Add ${schema.title || "database"}` : "Add database"}
          </button>
        </div>
      </div>
    </TasksModal>
  );
}
